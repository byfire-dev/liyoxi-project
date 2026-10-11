import type { Tx } from "../kernel/index.js";

/** 草稿删除不能把已确认或已取消的广告当作从未发生。 */
export function countStoreAdHistory(tx: Tx, input: { entityId: string; storeId: string }) {
  return tx.ad.count({ where: input });
}

/** m06 第1节：五种制作中状态阻止门店停用，已确认与已取消不计。 */
export function countBlockingStoreAds(tx: Tx, storeId: string): Promise<number> {
  return tx.ad.count({
    where: {
      storeId,
      status: { in: ["pending_assign", "producing", "returned", "pending_confirm", "revising"] },
    },
  });
}
