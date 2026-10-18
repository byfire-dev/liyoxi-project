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
export async function assetDemandForNotify(tx: Tx, id: string) {
  const row = await tx.storeAssetDemand.findUnique({ where: { id } });
  if (!row) return null;
  return {
    bizType: "store_asset_demand",
    bizId: row.id,
    entityId: row.entityId,
    storeId: row.storeId,
    status: row.status,
    version: 0,
    name: row.title,
    targetDate: row.dueDate.toISOString().slice(0, 10),
    notifyScope: row.notifyScope,
  };
}
