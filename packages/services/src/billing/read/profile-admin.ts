import type { AdminFacts, AdminFactsQuery } from "../../profile/index.js";
import type { Tx } from "../../kernel/index.js";
import { getWalletView } from "./index.js";
import { paymentTitle, readTenantAdminBillingFacts } from "./tenant-admin.js";

/** 同调用方事务读取主体事实，金额按净实付，笔数只含当前 paid；不推进账本。 */
export async function readProfileAdminBillingFacts(
  tx: Tx,
  q: AdminFactsQuery,
): Promise<AdminFacts["billing"]> {
  const { subscription } = await readTenantAdminBillingFacts(tx, q);
  const { points } = await getWalletView(tx, q.entityId, q.now);
  const paid = await tx.billingOrder.aggregate({
    where: { entityId: q.entityId, status: { in: ["paid", "refunded"] } },
    _sum: { paidAmountFen: true, refundedAmountFen: true },
  });
  const counts = await tx.billingOrder.groupBy({
    by: ["type"],
    where: { entityId: q.entityId, status: "paid" },
    _count: true,
  });
  const pending = await tx.pointAdjustmentRequest.findFirst({
    where: { entityId: q.entityId, approvalRequest: { status: "pending" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      direction: true,
      lotKind: true,
      adjustPoints: true,
      approvalRequest: { select: { requestNo: true } },
    },
  });
  const related = await tx.billingOrder.findMany({
    where: { entityId: q.entityId, status: { in: ["pending_payment", "pending_confirmation"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      orderNo: true,
      type: true,
      contentSnapshot: true,
      status: true,
      amountFen: true,
    },
  });
  return {
    subscription,
    points: {
      spendablePoints: points.spendablePoints,
      planAvailablePoints: points.planAvailablePoints,
      addonAvailablePoints: points.addonAvailablePoints,
      heldPoints: points.heldPoints,
      isAddonSuspended: points.isAddonSuspended,
    },
    paid: {
      totalPaidFen: (paid._sum.paidAmountFen ?? 0) - (paid._sum.refundedAmountFen ?? 0),
      paidOrderCount: counts.reduce((n, r) => n + r._count, 0),
      planOrderCount: counts.filter((r) => r.type !== "topup").reduce((n, r) => n + r._count, 0),
      topupOrderCount: counts.find((r) => r.type === "topup")?._count ?? 0,
    },
    pendingPointAdjustment: pending
      ? {
          pointAdjustmentRequestId: pending.id,
          requestNo: pending.approvalRequest.requestNo,
          direction: pending.direction,
          lotKind: pending.lotKind,
          adjustPoints: pending.adjustPoints,
        }
      : null,
    relatedOrders: await Promise.all(
      related.map(async (r) => ({
        kind: "payment_order" as const,
        id: r.id,
        no: r.orderNo,
        title: await paymentTitle(tx, r.type, r.contentSnapshot),
        statusText: r.status === "pending_confirmation" ? "待确认收款" : "待付款",
        amountFen: r.amountFen,
        heldPoints: null,
      })),
    ),
  };
}
