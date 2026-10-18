import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Tx, MerchantFactsQuery } from "../../kernel/index.js";
import { assetSelectable } from "./steps.js";
/** 只排除软删除与复制素材，审核、处理、角色和成员状态不改变上传历史。 */
export function countStoreOriginalAssets(tx: Tx, input: { entityId: string; storeId: string }) {
  return tx.storeAsset.count({ where: { ...input, deletedAt: null, sourceStoreAssetId: null } });
}
export async function assetMerchantFacts(tx: Tx, query: MerchantFactsQuery) {
  const stores: Record<string, { assetCount: number; recent7dCount: number }> = {};
  for (const id of query.storeIds) {
    const where = { entityId: query.entityId, storeId: id, deletedAt: null };
    stores[id] = {
      assetCount: await tx.storeAsset.count({ where }),
      recent7dCount: await tx.storeAsset.count({
        where: { ...where, createdAt: { gte: new Date(query.now.getTime() - 7 * 86400000) } },
      }),
    };
  }
  return { stores };
}
export async function assertAssetReferences(
  tx: Tx,
  input: { entityId: string; storeId: string; ids: readonly string[] },
  lock = false,
) {
  const ids = [...new Set(input.ids)];
  if (ids.length !== input.ids.length) throw new AppError("VALIDATION_FAILED");
  if (lock) await lockRows(tx, "store_asset", ids);
  const rows = await tx.storeAsset.findMany({
    where: { id: { in: ids }, entityId: input.entityId, storeId: input.storeId },
  });
  for (const id of ids) {
    const row = rows.find((row) => row.id === id);
    if (!row || !assetSelectable(row))
      throw new AppError("VALIDATION_FAILED", {
        details: {
          fieldErrors: [
            {
              path: `referenceStoreAssetIds.${input.ids.indexOf(id)}`,
              message: "请选择本门店未删除、未拦截且无需重拍的素材",
            },
          ],
        },
      });
  }
}
export async function linkAssetReferences(
  tx: Tx,
  input: { entityId: string; storeId: string; ids: readonly string[]; orderId: string; now: Date },
) {
  await assertAssetReferences(tx, input);
  await tx.storeAssetUsage.createMany({
    data: input.ids.map((id) => ({
      id: uuidv7(),
      storeAssetId: id,
      usedByType: "drama_order",
      usedById: input.orderId,
      role: "reference",
      createdAt: input.now,
    })),
    skipDuplicates: true,
  });
}
export async function readOrderAssetReferences(tx: Tx, orderId: string) {
  return (
    await tx.storeAssetUsage.findMany({
      where: { usedByType: "drama_order", usedById: orderId, role: "reference" },
      orderBy: { id: "asc" },
      select: { storeAssetId: true },
    })
  ).map((row) => row.storeAssetId);
}
