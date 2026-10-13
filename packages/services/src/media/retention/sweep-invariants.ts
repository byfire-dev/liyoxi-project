import type { InvariantScope, InvariantViolation, Tx } from "../../kernel/index.js";
import { afterPurgedIn } from "./hooks.js";
import type { RetentionDeps } from "./types.js";
import { SWEEP_BATCH } from "./sweep-context.js";

export async function findI8Violations(
  deps: RetentionDeps,
  tx: Tx,
  scope: InvariantScope,
  now: Date,
): Promise<InvariantViolation[]> {
  if (scope.entityIds?.length === 0) return [];
  const bundles = await tx.zipBundle.findMany({
    where: {
      zipState: "ready",
      zipFile: {
        status: { not: "stored" },
        ...(scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {}),
      },
    },
    orderBy: { id: "asc" },
    take: SWEEP_BATCH,
    select: { id: true, zipFileId: true, zipFile: { select: { entityId: true } } },
  });
  const ended = await tx.$queryRawUnsafe<{ id: string; entityId: string | null }[]>(
    `
    SELECT DISTINCT f.id, f.entity_id AS "entityId" FROM file_object f JOIN file_ref r ON r.ref_id=f.id
    WHERE f.status='deleted' AND r.state='live'
      AND (r.ref_type='derivative' OR (r.ref_type='media_info' AND r.role='cover'))
      AND ($1::uuid[] IS NULL OR f.entity_id=ANY($1::uuid[]))
    ORDER BY f.id LIMIT ${SWEEP_BATCH}`,
    scope.entityIds ? [...scope.entityIds] : null,
  );
  const ids = [
    ...new Set([
      ...bundles.flatMap((bundle) => (bundle.zipFileId ? [bundle.zipFileId] : [])),
      ...ended.map((file) => file.id),
    ]),
  ];
  await afterPurgedIn({ ...deps, clock: { now: () => new Date(now) } }, tx, ids);
  return [
    ...bundles.map((bundle) => ({
      subject: { type: "zip_bundle", id: bundle.id },
      ...(bundle.zipFile?.entityId ? { entityId: bundle.zipFile.entityId } : {}),
      detail: { problem: "ready ZIP指向非stored文件" },
      healed: { action: "清除缓存并推进zipGen", at: now },
    })),
    ...ended.map((file) => ({
      subject: { type: "file_object", id: file.id },
      ...(file.entityId ? { entityId: file.entityId } : {}),
      detail: { problem: "已清除源文件仍有派生引用" },
      healed: { action: "重试分类清除钩子", at: now },
    })),
  ];
}

export async function findI13Violations(
  tx: Tx,
  scope: InvariantScope,
  now: Date,
): Promise<InvariantViolation[]> {
  if (scope.entityIds?.length === 0) return [];
  const rows = await tx.$queryRawUnsafe<{ id: string; entityId: string | null }[]>(
    `
    SELECT f.id, f.entity_id AS "entityId" FROM file_object f WHERE f.status='stored'
      AND ($2::uuid[] IS NULL OR f.entity_id=ANY($2::uuid[]))
      AND f.purge_after IS DISTINCT FROM CASE
        WHEN EXISTS(SELECT 1 FROM file_ref r WHERE r.file_id=f.id AND (r.state='live' OR r.keep_until IS NULL)) THEN NULL
        WHEN EXISTS(SELECT 1 FROM file_ref r WHERE r.file_id=f.id) THEN (SELECT max(r.keep_until) FROM file_ref r WHERE r.file_id=f.id)
        WHEN f.first_linked_at IS NULL AND f.stored_at <= $1::timestamptz - interval '24 hours' THEN f.stored_at + interval '24 hours'
        ELSE NULL END ORDER BY f.id LIMIT ${SWEEP_BATCH}`,
    now,
    scope.entityIds ? [...scope.entityIds] : null,
  );
  return rows.map((file) => ({
    subject: { type: "file_object", id: file.id },
    ...(file.entityId ? { entityId: file.entityId } : {}),
    detail: { problem: "purge_after与真实引用/24小时保护期不符" },
  }));
}
