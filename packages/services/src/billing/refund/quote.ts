import { CashRefundQuoteSchema, fulfillResultSchema } from "@liyoxi/contract";
import type { CashRefundQuote } from "@liyoxi/contract";
import type { BillingOrder } from "@liyoxi/db";
import { paramsAt } from "../../config/index.js";
import type { Tx } from "../../kernel/index.js";
import { hasPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { staffBrief } from "../payment/purchase-read.js";
import { termsOf } from "./context.js";
import type { RefundDeps } from "./context.js";

export async function receiptView(tx: Tx, id: string) {
  const r = await tx.paymentTxn.findUniqueOrThrow({ where: { id } });
  return {
    paymentTransactionId: r.id,
    attemptNo: r.attemptNo,
    channel: r.channel,
    status: r.status,
    outTradeNo: r.outTradeNo,
    channelTxnNo: r.channelTxnNo,
    channelAmountFen: r.channelAmountFen,
    feeFen: r.feeFen,
    channelSuccessAt: r.channelSuccessAt?.toISOString() ?? null,
    isApplied: r.appliedAt !== null,
    refundedFen: r.refundedFen,
    reconState: r.reconState,
    payerName: r.channel === "bank_transfer" ? r.channelPayerRef : null,
    confirmedBy: await staffBrief(tx, r.confirmedByStaffId),
    reviewedBy: await staffBrief(tx, r.reviewedByStaffId),
  };
}
export async function originalRoute(
  tx: Tx,
  deps: RefundDeps,
  receipt: { channel: string; channelSuccessAt: Date | null },
) {
  const values = await paramsAt(tx, ["refund.original_route_safety_hours"], deps.clock.now());
  return (
    receipt.channel === "wechat_jsapi" &&
    receipt.channelSuccessAt &&
    deps.clock.now().getTime() <
      receipt.channelSuccessAt.getTime() +
        (365 * 24 - Number(values["refund.original_route_safety_hours"])) * 3_600_000
  );
}
export async function quote(
  tx: Tx,
  deps: RefundDeps,
  staff: StaffContext,
  order: BillingOrder,
  requested?: string,
): Promise<CashRefundQuote> {
  const receipt = order.paidPaymentTxnId
    ? await tx.paymentTxn.findUnique({ where: { id: order.paidPaymentTxnId } })
    : null;
  const open = receipt
    ? await tx.refundRequest.findFirst({
        where: { paymentTxnId: receipt.id, closedAt: null },
        include: { approvalRequest: true },
      })
    : null;
  const parsed = fulfillResultSchema.safeParse(order.fulfillmentResult);
  const termId = parsed.success && parsed.data.status === "done" ? parsed.data.termId : null;
  const facts = termId ? await termsOf(deps).previewPlanRefund(tx, termId) : null;
  const dead = await deps.isQualificationDead(tx, order.entityId);
  const invoice = await tx.invoiceRequest.findFirst({
    where: { billingOrderId: order.id },
    orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
  });
  let unsupported: CashRefundQuote["unsupportedReason"] = null;
  if (!receipt || !["paid", "refunded"].includes(order.status)) unsupported = "not_paid";
  else if (receipt.refundedFen > 0) unsupported = "already_refunded";
  else if (open) unsupported = "open_request_exists";
  else if (order.type === "topup") unsupported = "topup_not_refundable";
  else if (order.fulfillmentStatus !== "done" || !facts) unsupported = "not_fulfilled";
  else if (order.type === "plan_upgrade" && !["refunded", "cancelled"].includes(facts.termStatus))
    unsupported = "upgrade_refund_source_first";
  const cashOnly =
    order.type === "plan_upgrade" && facts && ["refunded", "cancelled"].includes(facts.termStatus);
  const rules = (["window", "qualification_failed", "override"] as const).map((rule) => {
    const reasons: CashRefundQuote["rules"][number]["reasons"] = [];
    if (rule === "override" && cashOnly)
      return {
        rule,
        eligible: unsupported === null && hasPermission(staff, "refund.override.request"),
        reasons,
      };
    if (!facts || !["scheduled", "active"].includes(facts.termStatus))
      reasons.push("term_not_refundable");
    if (rule !== "override") {
      if (!facts?.unused) reasons.push("points_used");
      if (facts?.upgraded) reasons.push("term_upgraded");
      if (rule === "window" && !facts?.withinWindow) reasons.push("outside_window");
      if (rule === "qualification_failed" && !dead) reasons.push("qualification_not_dead");
    }
    return {
      rule,
      eligible:
        unsupported === null &&
        reasons.length === 0 &&
        (rule !== "override" || hasPermission(staff, "refund.override.request")),
      reasons,
    };
  });
  return CashRefundQuoteSchema.parse({
    supported: unsupported === null,
    unsupportedReason: unsupported,
    rules,
    suggestedRule:
      requested === "override" && rules[2]?.eligible
        ? "override"
        : (rules.find((r) => r.rule !== "override" && r.eligible)?.rule ?? null),
    refundableFen: receipt ? Math.max(0, (receipt.channelAmountFen ?? 0) - receipt.refundedFen) : 0,
    paymentTxn: receipt ? await receiptView(tx, receipt.id) : null,
    term: facts
      ? {
          subscriptionTermId: facts.termId,
          planName: (
            await tx.plan.findUniqueOrThrow({
              where: {
                id: (await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: facts.termId } }))
                  .planId,
              },
            })
          ).name,
          status: facts.termStatus,
          startsAt: facts.termStartsAt,
          endsAt: facts.termEndsAt,
          upgraded: facts.upgraded,
        }
      : null,
    windowDeadline: facts?.windowDeadline ?? null,
    withinWindow: facts?.withinWindow ?? false,
    unused: facts?.unused ?? false,
    sideEffects: cashOnly
      ? { revokePoints: 0, cancelSchedules: 0, addonWillSuspend: 0, nextTermWillStartNow: false }
      : (facts?.sideEffects ?? {
          revokePoints: 0,
          cancelSchedules: 0,
          addonWillSuspend: 0,
          nextTermWillStartNow: false,
        }),
    routePreview:
      receipt && (await originalRoute(tx, deps, receipt)) ? "wechat_original" : "offline",
    invoice: {
      latestStatus: invoice?.status ?? null,
      needsRedInvoice: !!invoice && ["issued", "red_pending"].includes(invoice.status),
    },
    openRequest: open
      ? { refundRequestId: open.id, requestNo: open.approvalRequest.requestNo, status: open.status }
      : null,
  });
}
