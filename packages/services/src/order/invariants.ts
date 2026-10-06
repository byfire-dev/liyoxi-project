import type { InvariantScope, InvariantViolation, Tx } from "../kernel/index.js";
export const ORDER_INVARIANT_CODES = [
  "pending_totals",
  "pending_accounts",
  "pending_holds",
] as const;
export async function findOrderViolations(
  tx: Tx,
  code: (typeof ORDER_INVARIANT_CODES)[number],
  scope: InvariantScope = {},
): Promise<InvariantViolation[]> {
  const orders = await tx.dramaOrder.findMany({
    where: {
      status: "pending_start",
      ...(scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {}),
    },
    include: { orderItems: { include: { orderItemAccounts: true, pointHold: true } } },
  });
  const violations: InvariantViolation[] = [];
  for (const o of orders) {
    const bad = (id: string, type: string, detail: Record<string, unknown>) =>
      violations.push({ subject: { type, id }, entityId: o.entityId, detail });
    if (
      code === "pending_totals" &&
      (o.itemCount !== o.orderItems.length ||
        o.totalChargePoints !== o.orderItems.reduce((n, i) => n + i.chargePoints, 0))
    )
      bad(o.id, "drama_order", {
        itemCount: o.itemCount,
        actualCount: o.orderItems.length,
        totalChargePoints: o.totalChargePoints,
      });
    for (const i of o.orderItems) {
      if (code === "pending_accounts" && i.orderItemAccounts.length === 0)
        bad(i.id, "order_item", { missingAccount: true });
      if (
        code === "pending_holds" &&
        (i.phase !== "pending_start" ||
          i.pointHold.status !== "held" ||
          i.pointHold.qty !== i.chargePoints ||
          i.pointHold.refType !== "order_item" ||
          i.pointHold.refId !== i.id ||
          i.pointHold.entityId !== i.entityId ||
          i.pointHold.storeId !== i.storeId ||
          i.refundRequestedPoints !== 0 ||
          i.returnedPoints !== i.pointHold.returnedQty ||
          i.convertedPoints !== 0 ||
          i.forfeitedPoints !== i.pointHold.forfeitedQty)
      )
        bad(i.id, "order_item", {
          phase: i.phase,
          holdStatus: i.pointHold.status,
          chargePoints: i.chargePoints,
          holdPoints: i.pointHold.qty,
        });
    }
  }
  return violations;
}
