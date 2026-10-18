import { lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { ObjectRef } from "../../providers/types.js";
import { release } from "../refs.js";
import { SWEEP_BATCH } from "./sweep-context.js";
import type { SweepContext } from "./sweep-context.js";
import { purgeAfter } from "./current-refs.js";

const activeBatches = ["matching", "uploading", "verifying", "ready"];
export async function expireUploads(ctx: SweepContext) {
  return ctx.transaction("uploads", async (tx) => {
    const now = ctx.deps.clock.now();
    const files = await tx.fileObject.findMany({
      where: { status: "pending", uploadExpiresAt: { lte: now } },
      orderBy: { id: "asc" },
      take: SWEEP_BATCH,
    });
    const ids = files.map((file) => file.id);
    await lockRows(tx, "production_record", ids);
    await lockRows(tx, "file_object", ids);
    let expired = 0;
    for (const file of files) {
      const changed = await tx.fileObject.updateMany({
        where: { id: file.id, status: "pending", uploadExpiresAt: { lte: now } },
        data: {
          status: "expired",
          incomingKey: null,
          incomingBucket: null,
          confirmingUntil: null,
          updatedAt: now,
        },
      });
      if (changed.count) {
        expired++;
        await tx.productionRecord.updateMany({
          where: { fileId: file.id, pipelineState: "uploading" },
          data: { pipelineState: "rejected", updatedAt: now },
        });
      }
    }
    return expired;
  });
}
export async function cleanIncoming(ctx: SweepContext) {
  return ctx.stage("incoming", async (scope) => {
    const files = await ctx.tx.run((tx) =>
      tx.fileObject.findMany({
        where: { status: "rejected", incomingKey: { not: null } },
        orderBy: { id: "asc" },
        take: SWEEP_BATCH,
      }),
    );
    let cleaned = 0;
    for (const file of files) {
      await scope.assertHeld();
      if (!file.incomingBucket || !file.incomingKey)
        throw new TypeError("拒收文件写入区事实不完整");
      const result = await ctx.deps.storage.delete({
        bucket: file.incomingBucket as ObjectRef["bucket"],
        key: file.incomingKey,
        signal: scope.signal,
      });
      if (!result.ok) throw new Error("写入区删除结果未知");
      cleaned += await ctx.tx.run(async (tx) => {
        await lockRows(tx, "file_object", [file.id]);
        return (
          await tx.fileObject.updateMany({
            where: {
              id: file.id,
              status: "rejected",
              incomingKey: file.incomingKey,
              incomingBucket: file.incomingBucket,
            },
            data: { incomingKey: null, incomingBucket: null, updatedAt: ctx.deps.clock.now() },
          })
        ).count;
      });
    }
    return cleaned;
  });
}
/** 只查缓存不一致的首100行；稳定行不会占住后续页。 */
export async function repairPurgeCache(tx: Tx, now: Date, entityIds?: readonly string[]) {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `
    SELECT f.id FROM file_object f WHERE f.status='stored'
      AND ($2::uuid[] IS NULL OR f.entity_id=ANY($2::uuid[]))
      AND f.purge_after IS DISTINCT FROM CASE
        WHEN EXISTS(SELECT 1 FROM file_ref r WHERE r.file_id=f.id AND (r.state='live' OR r.keep_until IS NULL)) THEN NULL
        WHEN EXISTS(SELECT 1 FROM file_ref r WHERE r.file_id=f.id) THEN (SELECT max(r.keep_until) FROM file_ref r WHERE r.file_id=f.id)
        WHEN f.first_linked_at IS NULL AND f.stored_at <= $1::timestamptz - interval '24 hours' THEN f.stored_at + interval '24 hours'
        ELSE NULL END
    ORDER BY f.id LIMIT ${SWEEP_BATCH}`,
    now,
    entityIds ? [...entityIds] : null,
  );
  await lockRows(
    tx,
    "file_object",
    rows.map((row) => row.id),
  );
  const changed: { id: string; entityId: string | null }[] = [];
  for (const row of rows) {
    const file = await tx.fileObject.findUniqueOrThrow({ where: { id: row.id } });
    if (file.status !== "stored") continue;
    let expected = await purgeAfter(tx, file);
    if (
      !file.firstLinkedAt &&
      expected &&
      expected > now &&
      !(await tx.fileRef.count({ where: { fileId: file.id } }))
    )
      expected = null;
    if (file.purgeAfter?.getTime() === expected?.getTime()) continue;
    await tx.fileObject.update({
      where: { id: row.id },
      data: { purgeAfter: expected, updatedAt: now },
    });
    changed.push({ id: file.id, entityId: file.entityId });
  }
  return changed;
}
export async function expireBatches(ctx: SweepContext) {
  const batches = await ctx.tx.run((tx) =>
    tx.uploadBatch.findMany({
      where: { state: { in: activeBatches }, expiresAt: { lte: ctx.deps.clock.now() } },
      orderBy: { id: "asc" },
      take: SWEEP_BATCH,
      select: { id: true },
    }),
  );
  let expired = 0;
  for (const candidate of batches)
    expired += await ctx.transaction(`batch:${candidate.id}`, async (tx) => {
      const initial = await tx.fileObject.findMany({
        where: { uploadBatchId: candidate.id },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      await lockRows(
        tx,
        "production_record",
        initial.map((file) => file.id),
      );
      await lockRows(tx, "upload_batch", [candidate.id]);
      const now = ctx.deps.clock.now(),
        batch = await tx.uploadBatch.findUniqueOrThrow({ where: { id: candidate.id } });
      if (!activeBatches.includes(batch.state) || batch.expiresAt > now) return 0;
      const files = await tx.fileObject.findMany({
        where: { uploadBatchId: batch.id },
        orderBy: { id: "asc" },
      });
      if (files.some((file) => !initial.some((known) => known.id === file.id)))
        throw new Error("批次文件集合在加锁后漂移，下一轮重读");
      await lockRows(
        tx,
        "file_object",
        files.map((file) => file.id),
      );
      for (const previous of files) {
        const file = await tx.fileObject.findUniqueOrThrow({ where: { id: previous.id } });
        if (file.status === "pending") {
          await tx.fileObject.update({
            where: { id: file.id },
            data: {
              status: "expired",
              incomingBucket: null,
              incomingKey: null,
              confirmingUntil: null,
              updatedAt: now,
            },
          });
          await tx.productionRecord.updateMany({
            where: { fileId: file.id, pipelineState: "uploading" },
            data: { pipelineState: "rejected", updatedAt: now },
          });
        } else if (file.status === "stored") {
          await release(ctx.deps, tx, {
            fileId: file.id,
            entityId: file.entityId,
            storeId: file.storeId,
            refType: "upload_batch",
            refId: batch.id,
            role: "main",
            keepUntil: new Date(now.getTime() + 3 * 86_400_000),
          });
        }
      }
      await tx.uploadBatch.updateMany({
        where: { id: batch.id, state: batch.state, expiresAt: { lte: now } },
        data: { state: "expired", updatedAt: now },
      });
      return 1;
    });
  return expired;
}
export async function purgeOcrRaw(ctx: SweepContext) {
  return ctx.transaction("ocr", async (tx) => {
    const now = ctx.deps.clock.now(),
      rows = await tx.ocrResult.findMany({
        where: { rawEnc: { not: null }, rawPurgeAt: { lte: now } },
        orderBy: { id: "asc" },
        take: SWEEP_BATCH,
        select: { id: true },
      });
    return (
      await tx.ocrResult.updateMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          rawEnc: { not: null },
          rawPurgeAt: { lte: now },
        },
        data: { rawEnc: null, updatedAt: now },
      })
    ).count;
  });
}
