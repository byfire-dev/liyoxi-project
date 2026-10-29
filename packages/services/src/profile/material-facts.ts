import type { Tx } from "../kernel/index.js";

/** Removed profile media remains readable when the order still retains its reference. */
export async function readMaterialProfile(
  tx: Tx,
  input: { entityId: string; storeId: string; fileIds?: readonly string[] },
) {
  const [profile, media] = await Promise.all([
    tx.storeProfile.findFirst({
      where: { storeId: input.storeId, entityId: input.entityId },
      select: {
        brandName: true,
        brandIntro: true,
        promoText: true,
        groupBuyText: true,
        sellingNote: true,
        bannedTerms: true,
      },
    }),
    tx.storeProfileMedia.findMany({
      where: {
        entityId: input.entityId,
        storeId: input.storeId,
        ...(input.fileIds ? { fileId: { in: [...input.fileIds] } } : {}),
      },
      select: { fileId: true, mediaGroup: true, mediaKind: true, removedAt: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    }),
  ]);
  return {
    text: profile ?? {
      brandName: null,
      brandIntro: null,
      promoText: null,
      groupBuyText: null,
      sellingNote: null,
      bannedTerms: null,
    },
    media,
  };
}
