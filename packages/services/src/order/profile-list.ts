import type { Tx } from "../kernel/index.js";

/** 只聚合调用方已裁剪的门店ID，包含已结/取消的真实订购历史。 */
export async function readProfileStoreLastOrders(tx: Tx, storeIds: readonly string[]) {
  const ids = [...new Set(storeIds)],
    result = new Map<string, Date | null>(ids.map((id) => [id, null]));
  if (!ids.length) return result;
  const rows = await tx.dramaOrder.groupBy({
    by: ["storeId"],
    where: { storeId: { in: ids } },
    _max: { submittedAt: true },
  });
  for (const row of rows) result.set(row.storeId, row._max.submittedAt);
  return result;
}
