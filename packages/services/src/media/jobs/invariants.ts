import { Prisma } from "@liyoxi/db";
import { lockRows } from "../../kernel/index.js";
import type { InvariantScope, InvariantViolation, Tx } from "../../kernel/index.js";
import type { MediaJobs } from "./runner.js";
import type { MediaParentType } from "./types.js";
type MediaJobResolver = MediaJobs | (() => MediaJobs);
const resolveJobs = (jobs: MediaJobResolver): MediaJobs =>
  typeof jobs === "function" ? jobs() : jobs;
const active = ["queued", "running", "submitting", "submitted"];
const parentOrder: readonly MediaParentType[] = [
  "playable_asset",
  "production_record",
  "store_asset",
  "upload_batch",
  "zip_bundle",
];
async function lockParents(
  tx: Tx,
  rows: readonly { parentType: string | null; parentId: string | null }[],
) {
  for (const type of parentOrder) {
    const ids = [
      ...new Set(
        rows.filter((row) => row.parentType === type && row.parentId).map((row) => row.parentId!),
      ),
    ].sort();
    if (ids.length) await lockRows(tx, type, ids);
  }
}
export async function findI10Violations(
  tx: Tx,
  scope: InvariantScope,
  now: Date,
  jobs: MediaJobResolver,
): Promise<InvariantViolation[]> {
  if (scope.entityIds?.length === 0) return [];
  const scoped =
    scope.entityIds === undefined
      ? Prisma.empty
      : Prisma.sql`AND (
    EXISTS (SELECT 1 FROM file_object f WHERE j.subject_type='file_object' AND f.id=j.subject_id AND f.entity_id IN (${Prisma.join([...scope.entityIds])}))
    OR EXISTS (SELECT 1 FROM store_asset s WHERE j.parent_type='store_asset' AND s.id=j.parent_id AND s.entity_id IN (${Prisma.join([...scope.entityIds])}))
    OR EXISTS (SELECT 1 FROM playable_asset p WHERE j.parent_type='playable_asset' AND p.id=j.parent_id AND p.entity_id IN (${Prisma.join([...scope.entityIds])}))
  )`;
  // Deadline transitions remain eligible in quick mode even if no row changed since the previous run.
  const ids = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT j.id::text FROM media_job j WHERE j.state IN ('queued','running','submitting','submitted') AND j.deadline_at<=${now} ${scoped} ORDER BY j.id`,
  );
  const rows = await tx.mediaJob.findMany({
    where: { id: { in: ids.map((row) => row.id) } },
    orderBy: { id: "asc" },
  });
  if (!rows.length) return [];
  const executor = resolveJobs(jobs);
  await lockParents(tx, rows);
  if (rows.length)
    await lockRows(
      tx,
      "media_job",
      rows.map((row) => row.id),
    );
  const files = [
    ...new Set(rows.filter((row) => row.subjectType === "file_object").map((row) => row.subjectId)),
  ].sort();
  if (files.length) await lockRows(tx, "file_object", files);
  const violations: InvariantViolation[] = [];
  for (const row of rows) {
    if (await executor.expire(tx, row.id, now))
      violations.push({
        subject: { type: "media_job", id: row.id },
        detail: { problem: "媒体任务超过deadline仍未结束" },
        healed: { action: "按当前处理器收尾并同TX汇合", at: now },
      });
  }
  return violations;
}
type Parent = { id: string; parentType: MediaParentType; entityId?: string | null };
async function staleParents(tx: Tx, scope: InvariantScope, cutoff: Date): Promise<Parent[]> {
  if (scope.entityIds?.length === 0) return [];
  const entity = scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {};
  const [assets, stores, batches, productions] = await Promise.all([
    tx.playableAsset.findMany({
      where: { state: "processing", updatedAt: { lte: cutoff }, ...entity },
      select: { id: true, entityId: true },
    }),
    tx.storeAsset.findMany({
      where: {
        processingState: { in: ["pending", "processing"] },
        updatedAt: { lte: cutoff },
        ...entity,
      },
      select: { id: true, entityId: true },
    }),
    tx.uploadBatch.findMany({
      where: {
        state: "verifying",
        updatedAt: { lte: cutoff },
        ...(scope.entityIds
          ? { uploadBatchItems: { some: { file: { entityId: { in: [...scope.entityIds] } } } } }
          : {}),
      },
      select: { id: true },
    }),
    tx.productionRecord.findMany({
      where: {
        pipelineState: "checking",
        updatedAt: { lte: cutoff },
        ...(scope.entityIds ? { file: { entityId: { in: [...scope.entityIds] } } } : {}),
      },
      select: { fileId: true },
    }),
  ]);
  return [
    ...assets.map((row) => ({ ...row, parentType: "playable_asset" as const })),
    ...stores.map((row) => ({ ...row, parentType: "store_asset" as const })),
    ...batches.map((row) => ({ ...row, parentType: "upload_batch" as const })),
    ...productions.map((row) => ({ id: row.fileId, parentType: "production_record" as const })),
  ];
}
export async function findI11Violations(
  tx: Tx,
  scope: InvariantScope,
  now: Date,
  jobs: MediaJobResolver,
): Promise<InvariantViolation[]> {
  const cutoff = new Date(now.getTime() - 15 * 60_000);
  const candidates = await staleParents(tx, scope, cutoff);
  await lockParents(
    tx,
    candidates.map((row) => ({ parentId: row.id, parentType: row.parentType })),
  );
  const jobRows = await tx.mediaJob.findMany({
    where: { OR: candidates.map((row) => ({ parentId: row.id, parentType: row.parentType })) },
    orderBy: { id: "asc" },
  });
  if (jobRows.length)
    await lockRows(
      tx,
      "media_job",
      jobRows.map((row) => row.id),
    );
  const files = [
    ...new Set(
      jobRows.filter((row) => row.subjectType === "file_object").map((row) => row.subjectId),
    ),
  ].sort();
  if (files.length) await lockRows(tx, "file_object", files);
  const stillStale = await staleParents(tx, scope, cutoff);
  const current = new Set(stillStale.map((row) => `${row.parentType}:${row.id}`));
  const violations: InvariantViolation[] = [];
  let executor: MediaJobs | undefined;
  for (const parent of candidates) {
    if (!current.has(`${parent.parentType}:${parent.id}`)) continue;
    if (
      await tx.mediaJob.count({
        where: { parentType: parent.parentType, parentId: parent.id, state: { in: active } },
      })
    )
      continue;
    const handler = (executor ??= resolveJobs(jobs)).convergence.get(parent.parentType);
    await handler?.converge(tx, parent.id, now);
    const remains = (await staleParents(tx, scope, cutoff)).some(
      (row) => row.id === parent.id && row.parentType === parent.parentType,
    );
    violations.push({
      subject: { type: parent.parentType, id: parent.id },
      ...(parent.entityId ? { entityId: parent.entityId } : {}),
      detail: { problem: "父对象停滞且无未结束任务", handlerConfigured: Boolean(handler) },
      ...(!remains ? { healed: { action: "复用业务纯决策汇合", at: now } } : {}),
    });
  }
  return violations;
}
