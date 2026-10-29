import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** Owned material projections omit object storage credentials and provider payloads. */
export async function readMaterialAssetFacts(
  tx: Tx,
  input: { entityId: string; storeId: string; ids: readonly string[] },
) {
  return tx.storeAsset.findMany({
    where: { id: { in: [...input.ids] }, entityId: input.entityId, storeId: input.storeId },
    select: {
      id: true,
      type: true,
      title: true,
      usability: true,
      deletedAt: true,
      moderationState: true,
      processingState: true,
      lockVersion: true,
      storeAssetFiles: { select: { fileId: true, position: true }, orderBy: { position: "asc" } },
    },
    orderBy: { id: "asc" },
  });
}

export async function readOrderReferenceFileIds(
  tx: Tx,
  input: { orderId: string; entityId: string; storeId: string },
) {
  const [refs, assetUsages] = await Promise.all([
    tx.fileRef.findMany({
      where: {
        refType: "drama_order",
        refId: input.orderId,
        role: "reference",
        state: "live",
        file: { entityId: input.entityId },
      },
      select: { fileId: true },
      orderBy: { fileId: "asc" },
    }),
    tx.storeAssetUsage.findMany({
      where: { usedByType: "drama_order", usedById: input.orderId, role: "reference" },
      select: { storeAsset: { select: { storeAssetFiles: { select: { fileId: true } } } } },
    }),
  ]);
  const assetFiles = new Set(
    assetUsages.flatMap((u) => u.storeAsset.storeAssetFiles.map((f) => f.fileId)),
  );
  return refs.flatMap((r) => (assetFiles.has(r.fileId) ? [] : [r.fileId]));
}

export async function readMaterialFileFacts(tx: Tx, fileIds: readonly string[]) {
  return tx.fileObject.findMany({
    where: { id: { in: [...fileIds] } },
    select: {
      id: true,
      category: true,
      scopeType: true,
      entityId: true,
      storeId: true,
      status: true,
      moderationState: true,
      originalName: true,
      ext: true,
      sizeBytes: true,
      objectKey: true,
      etag: true,
      deletedAt: true,
      erasedAt: true,
      productionRecord: { select: { pipelineState: true } },
    },
    orderBy: { id: "asc" },
  });
}

export function readMaterialCheckouts(tx: Tx, input: { orderItemId: string; staffId: string }) {
  return tx.masterCheckout.findMany({ where: input, orderBy: { episodeNo: "asc" } });
}

/** The delivery use case has locked and re-read its current parent and selected version. */
export async function checkoutMaterialMaster(
  tx: Tx,
  input: {
    orderItemId: string;
    episodeNo: number;
    staffId: string;
    dramaEpisodeMasterId: string;
    now: Date;
  },
) {
  const { now, ...keyAndVersion } = input;
  if (!Number.isInteger(input.episodeNo) || input.episodeNo < 1)
    throw new AppError("VALIDATION_FAILED");
  await tx.masterCheckout.upsert({
    where: {
      orderItemId_episodeNo_staffId: {
        orderItemId: input.orderItemId,
        episodeNo: input.episodeNo,
        staffId: input.staffId,
      },
    },
    create: {
      ...keyAndVersion,
      checkedOutAt: now,
      checkoutCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    update: {
      dramaEpisodeMasterId: input.dramaEpisodeMasterId,
      checkedOutAt: now,
      checkoutCount: { increment: 1 },
      updatedAt: now,
    },
  });
}
