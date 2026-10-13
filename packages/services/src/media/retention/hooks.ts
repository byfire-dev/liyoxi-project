import type { Tx } from "../../kernel/index.js";
import { lockRows } from "../../kernel/index.js";
import { release } from "../refs.js";
import type { RetentionDeps } from "./types.js";
/** 文件事务提交后才取更低序ZIP锁；这些是media自己的表。 */
export async function afterPurged(deps: RetentionDeps, fileId: string) {
  await deps.tx.run((tx) => afterPurgedIn(deps, tx, [fileId]));
}
export async function afterPurgedIn(deps: RetentionDeps, tx: Tx, fileIds: readonly string[]) {
  const bundles = await tx.zipBundle.findMany({
    where: {
      OR: [{ zipFileId: { in: [...fileIds] } }, { publishListFileId: { in: [...fileIds] } }],
    },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "zip_bundle",
    bundles.map((b) => b.id),
  );
  for (const bundle of bundles) {
    if (bundle.zipFileId && fileIds.includes(bundle.zipFileId))
      await tx.zipBundle.updateMany({
        where: { id: bundle.id, zipFileId: { in: [...fileIds] }, zipState: "ready" },
        data: {
          zipState: "none",
          zipGen: { increment: 1 },
          zipFileId: null,
          publishListFileId: null,
          updatedAt: deps.clock.now(),
        },
      });
    else
      await tx.zipBundle.updateMany({
        where: { id: bundle.id, publishListFileId: { in: [...fileIds] } },
        data: { publishListFileId: null, updatedAt: deps.clock.now() },
      });
  }
  const refs = await tx.fileRef.findMany({
    where: {
      refId: { in: [...fileIds] },
      state: "live",
      OR: [{ refType: "derivative" }, { refType: "media_info", role: "cover" }],
    },
    orderBy: { fileId: "asc" },
  });
  await lockRows(tx, "file_object", [...new Set(refs.map((r) => r.fileId))].sort());
  for (const ref of refs) {
    if (ref.refType === "media_info") {
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: ref.fileId } });
      // 实际probe用media_info/cover，沿原release保留已登记30天缓冲，不假称derivative立即释放。
      await release(deps, tx, {
        fileId: ref.fileId,
        entityId: file.entityId,
        storeId: file.storeId,
        refType: ref.refType,
        refId: ref.refId,
        role: ref.role,
        keepUntil: deps.clock.now(),
      });
      continue;
    }
    await tx.fileRef.updateMany({
      where: { id: ref.id, state: "live" },
      data: {
        state: "released",
        releasedAt: deps.clock.now(),
        keepUntil: deps.clock.now(),
        updatedAt: deps.clock.now(),
      },
    });
    const remaining = await tx.fileRef.findMany({ where: { fileId: ref.fileId } });
    await tx.fileObject.update({
      where: { id: ref.fileId },
      data: {
        purgeAfter: remaining.some((r) => r.state === "live")
          ? null
          : new Date(Math.max(...remaining.map((r) => r.keepUntil?.getTime() ?? 0))),
        updatedAt: deps.clock.now(),
      },
    });
  }
}
