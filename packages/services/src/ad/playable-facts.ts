import type { Tx } from "../kernel/index.js";

/** Any pushed version remains visible, even while its ad is revising or cancelled. */
export function readAdPlayableFacts(
  tx: Tx,
  input: {
    adId: string;
    sourceFileId: string;
    entityId: string;
    storeId: string;
  },
) {
  return tx.adVersion.findFirst({
    where: {
      adId: input.adId,
      fileId: input.sourceFileId,
      entityId: input.entityId,
      storeId: input.storeId,
      ad: { id: input.adId, entityId: input.entityId, storeId: input.storeId },
      pushedAt: { not: null },
      previewChannels: { has: "weapp" },
    },
    select: {
      id: true,
      adId: true,
      fileId: true,
      versionNo: true,
      pushedAt: true,
      previewChannels: true,
      updatedAt: true,
    },
    orderBy: [{ versionNo: "desc" }, { id: "desc" }],
  });
}
