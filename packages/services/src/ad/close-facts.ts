import type { Tx } from "../kernel/index.js";

/** m06 第1节：五种制作中状态阻止门店停用，已确认与已取消不计。 */
export function countBlockingStoreAds(tx: Tx, storeId: string): Promise<number> {
  return tx.ad.count({
    where: {
      storeId,
      status: { in: ["pending_assign", "producing", "returned", "pending_confirm", "revising"] },
    },
  });
}
