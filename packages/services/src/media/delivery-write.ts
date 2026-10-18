import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";
import type { Events } from "../events/index.js";
import type { Media } from "./runtime.js";
export interface FinalBatchItem {
  readonly episodeNo: number;
  readonly fileId: string;
  readonly variant: "common";
}
export interface MediaDeliveryTarget {
  readonly entityId: string;
  readonly storeId: string;
  readonly orderItemId: string;
}

/** 父行、旧成片及 production360/asset370 须在本函数首次 batch380/file410 之前持有。 */
export async function consumeFinalReleaseBatch<T>(
  tx: Tx,
  deps: { clock: Clock; media: Pick<Media, "release"> },
  input: MediaDeliveryTarget & {
    batchId: string;
    expectedCount: number;
    candidateItems?: readonly FinalBatchItem[];
  },
  register: (
    items: readonly FinalBatchItem[],
  ) => Promise<{ value: T; refs: readonly { fileId: string; refId: string }[] }>,
): Promise<T> {
  await lockRows(tx, "upload_batch", [input.batchId]);
  const batch = await tx.uploadBatch.findUnique({
    where: { id: input.batchId },
    include: { uploadBatchItems: true },
  });
  if (!batch || batch.targetId !== input.orderItemId) throw new AppError("NOT_FOUND");
  if (batch.purpose !== "final_release")
    throw new AppError("BATCH_PURPOSE_MISMATCH", { details: { purpose: batch.purpose } });
  const now = deps.clock.now();
  if (batch.state !== "ready" || batch.expiresAt <= now) throw new AppError("STATE_NOT_ALLOWED");
  const valid = batch.uploadBatchItems.filter((i) => !["skipped", "replaced"].includes(i.state));
  if (
    batch.variant !== "common" ||
    batch.expectedCount !== input.expectedCount ||
    !valid.length ||
    valid.some(
      (i) =>
        i.state !== "checked" ||
        i.episodeNo === null ||
        i.episodeNo < 1 ||
        i.episodeNo > input.expectedCount,
    ) ||
    new Set(valid.map((i) => i.episodeNo)).size !== valid.length ||
    (batch.scope === "full" && valid.length !== input.expectedCount)
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const items: FinalBatchItem[] = valid.map((i) => ({
    episodeNo: i.episodeNo!,
    fileId: i.fileId,
    variant: "common",
  }));
  const fingerprint = (values: readonly FinalBatchItem[]) =>
    values
      .map((i) => `${i.episodeNo}:${i.fileId}:${i.variant}`)
      .sort()
      .join("|");
  if (input.candidateItems && fingerprint(input.candidateItems) !== fingerprint(items))
    throw new AppError("PRECONDITION_CHANGED");
  await lockRows(
    tx,
    "file_object",
    items.map((i) => i.fileId),
  );
  for (const i of items) {
    const f = await tx.fileObject.findUnique({ where: { id: i.fileId } });
    if (
      !f ||
      f.status !== "stored" ||
      f.category !== "final_episode" ||
      f.moderationState === "block" ||
      f.entityId !== input.entityId ||
      f.storeId !== input.storeId ||
      f.uploadBatchId !== batch.id
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [i.fileId], reason: "context_mismatch" },
      });
  }
  const registered = await register(items);
  for (const i of items) {
    const ref = registered.refs.find((r) => r.fileId === i.fileId);
    if (
      !ref ||
      !(await tx.fileRef.findFirst({
        where: {
          fileId: i.fileId,
          refType: "episode_output",
          refId: ref.refId,
          role: "main",
          state: "live",
        },
      }))
    )
      throw new AppError("INTERNAL", { message: "批次提交前必须建立新成片引用" });
  }
  for (const i of items)
    await deps.media.release(tx, {
      fileId: i.fileId,
      entityId: input.entityId,
      storeId: input.storeId,
      refType: "upload_batch",
      refId: batch.id,
      role: "main",
      keepUntil: now,
    });
  await tx.uploadBatch.update({
    where: { id: batch.id },
    data: { state: "committed", committedAt: now, updatedAt: now },
  });
  return registered.value;
}

export async function recordAdoptedStoreAssets(
  tx: Tx,
  deps: { clock: Clock; events: Pick<Events, "emit"> },
  ctx: IdentityContext,
  input: MediaDeliveryTarget & { storeAssetIds: readonly string[] },
) {
  const ids = [...new Set(input.storeAssetIds)].sort();
  await lockRows(tx, "store_asset", ids);
  const assets = await tx.storeAsset.findMany({ where: { id: { in: ids } } });
  if (
    assets.length !== ids.length ||
    assets.some(
      (a) =>
        a.entityId !== input.entityId ||
        a.storeId !== input.storeId ||
        a.deletedAt !== null ||
        a.moderationState === "block" ||
        a.processingState !== "processed" ||
        a.reviewState !== "reviewed" ||
        !["ready", "reference_only"].includes(a.usability ?? ""),
    )
  )
    throw new AppError("VALIDATION_FAILED", {
      details: { fieldErrors: [{ path: "adoptedStoreAssetIds", message: "素材不可用" }] },
    });
  let count = 0;
  for (const asset of assets) {
    const id = uuidv7(),
      now = deps.clock.now();
    const added = await tx.storeAssetUsage.createMany({
      data: [
        {
          id,
          storeAssetId: asset.id,
          usedByType: "order_item",
          usedById: input.orderItemId,
          role: "adopted",
          createdAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (!added.count) continue;
    await tx.storeAsset.update({
      where: { id: asset.id },
      data: { adoptedCount: { increment: 1 }, updatedAt: now },
    });
    await deps.events.emit(tx, ctx, {
      type: "asset.adopted",
      aggregate: { type: "store_asset", id: asset.id },
      entityId: input.entityId,
      storeId: input.storeId,
      dedupeKey: `asset.adopted:${id}`,
      payload: {
        v: 1,
        storeAssetId: asset.id,
        storeId: input.storeId,
        usedByType: "order_item",
        usedById: input.orderItemId,
        ...(asset.uploadActorType === "merchant" ? { uploaderUserId: asset.uploadActorId } : {}),
      },
    });
    count++;
  }
  return count;
}
