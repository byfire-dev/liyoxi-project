import type { Tx } from "../kernel/index.js";
export async function assetForNotify(tx: Tx, id: string) {
  const row = await tx.storeAsset.findUnique({ where: { id } });
  if (!row || row.deletedAt || row.uploadActorType !== "merchant") return null;
  return {
    bizType: "store_asset",
    bizId: row.id,
    entityId: row.entityId,
    storeId: row.storeId,
    status: row.adoptedCount > 0 ? "adopted" : row.reviewState,
    version: 0,
    name: "门店素材",
    merchantUserIds: [row.uploadActorId],
  };
}
