import type { BillingOrder } from "@liyoxi/db";
import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { Media } from "../../media/index.js";
import type { BillingPurchaseDeps, PurchaseActor } from "../payment/purchase-context.js";
export interface InvoiceDeps extends BillingPurchaseDeps {
  invoiceMedia: Pick<Media, "signRead">;
  invoiceMailEnabled: (tx: Tx) => Promise<boolean>;
  resendMail: (tx: Tx, invoiceDocId: string) => Promise<void>;
}
export async function assertInvoiceOwner(
  tx: Tx,
  deps: BillingPurchaseDeps,
  actor: PurchaseActor,
  lock = false,
) {
  if (
    actor.ctx.actor.type !== "merchant" ||
    actor.ctx.actor.id === null ||
    actor.ctx.actor.role !== "owner" ||
    actor.membership.role !== "owner" ||
    actor.ctx.entityId !== actor.membership.entityId
  )
    throw new AppError("ROLE_FORBIDDEN");
  if (lock) await lockRows(tx, "entity", [actor.membership.entityId]);
  const current = await deps.tenant.resolveMembership(tx, {
    merchantUserId: actor.ctx.actor.id,
    storeId: actor.membership.storeId,
  });
  if (!current || current.role !== "owner" || current.entityId !== actor.membership.entityId)
    throw new AppError("NOT_FOUND");
  return current;
}
export async function invoiceReasons(tx: Tx, order: BillingOrder, application = false) {
  const reasons: string[] = [];
  if (order.status !== "paid" || order.paidAt === null) reasons.push("not_paid");
  if (application && order.fulfillmentStatus !== "done") reasons.push("fulfillment_pending");
  if (order.refundedAmountFen !== 0) reasons.push("refunded");
  if (
    order.paidPaymentTxnId &&
    (await tx.refundRequest.count({
      where: {
        billingOrderId: order.id,
        paymentTxnId: order.paidPaymentTxnId,
        ruleCode: { not: "unapplied_receipt" },
        status: { in: ["pending_approval", "pending_execution", "executing"] },
      },
    }))
  )
    reasons.push("refund_in_flight");
  return reasons;
}
export function orderTitle(order: BillingOrder) {
  const c = order.contentSnapshot as {
    kind: string;
    planName?: string;
    months?: number;
    points?: number;
  };
  return c.kind === "topup"
    ? `加购 ${c.points ?? 0} 积分`
    : `${c.planName ?? "套餐"} · ${c.months ?? 1} 个月`;
}

export type InvoiceRuntimeDeps = Pick<InvoiceDeps, "clock" | "events" | "flow" | "sla" | "timers">;
