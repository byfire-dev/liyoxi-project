import type { Tx } from "../../kernel/index.js";

/** 取消拥有者只读取这份事实；不推进账本，不取得账户锁。 */
export function readCancelHoldFacts(tx: Tx, holdId: string) {
  return tx.pointHold.findUnique({
    where: { id: holdId },
    select: {
      id: true,
      entityId: true,
      storeId: true,
      purpose: true,
      refType: true,
      refId: true,
      status: true,
      qty: true,
      returnedQty: true,
      forfeitedQty: true,
      capturedAt: true,
      pricingSnapshot: true,
    },
  });
}
export type CancelHoldFacts = NonNullable<Awaited<ReturnType<typeof readCancelHoldFacts>>>;
