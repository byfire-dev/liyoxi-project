import { chainKey, rowKey } from "../../flow/index.js";
import type { Guard, MachineBinding } from "../../flow/index.js";
import { currentCalendarVersion } from "../../sla/index.js";
const guard: Guard = async (tx, facts) => {
  const request = await tx.refundRequest.findUnique({
    where: { id: facts.subjectId },
    include: { approvalRequest: true, paymentTxn: true, refundTxns: true },
  });
  if (
    !request ||
    request.approvalRequest.kind !== "plan_refund" ||
    request.entityId !== request.paymentTxn.entityId ||
    request.billingOrderId !== request.paymentTxn.billingOrderId
  )
    return false;
  const approval = request.approvalRequest;
  switch (facts.event) {
    case "refund.submit":
      return (
        approval.status === "pending" &&
        request.status === "pending_approval" &&
        request.amountFen > 0 &&
        request.amountFen <=
          (request.paymentTxn.channelAmountFen ?? 0) - request.paymentTxn.refundedFen
      );
    case "approval.approved":
      return approval.status === "approved" && request.status === "pending_approval";
    case "approval.rejected":
      return approval.status === "rejected";
    case "approval.withdrawn":
      return approval.status === "withdrawn";
    case "refund.execute":
      return (
        approval.status === "approved" &&
        request.refundTxns.some((t) => t.status === "created") &&
        !request.refundTxns.some((t) => ["processing", "abnormal"].includes(t.status))
      );
    case "refund.record_offline":
    case "refund.complete":
      return (
        request.refundTxns.some((t) => t.status === "succeeded") &&
        !request.refundTxns.some((t) => ["created", "processing", "abnormal"].includes(t.status))
      );
    case "refund.fail":
      return (
        request.refundTxns.some((t) =>
          ["closed", "not_accepted", "abandoned"].includes(t.status),
        ) &&
        !request.refundTxns.some((t) => ["created", "processing", "abnormal"].includes(t.status))
      );
    case "refund.void":
      return (
        approval.status === "approved" &&
        request.entitlementRevokedAt === null &&
        !request.refundTxns.some((t) =>
          ["created", "processing", "abnormal", "succeeded"].includes(t.status),
        )
      );
    case "sla.recalculated":
      return (
        facts.ctx.actor.type === "system" &&
        facts.ctx.actor.job === "billing.refund_calendar_imported" &&
        request.status === "pending_execution" &&
        request.executedAt === null &&
        (facts.args as { calendarVersion?: number } | undefined)?.calendarVersion ===
          (await currentCalendarVersion(tx))
      );
    default:
      return false;
  }
};
export const refundMachineKey = chainKey("refund_request", "status");
export const refundMachineBinding: MachineBinding = {
  companions: [
    "exec_route",
    "exec_due_at",
    "sla_snapshot",
    "entitlement_revoked_at",
    "executed_by_staff_id",
    "executed_at",
    "done_at",
    "closed_at",
    "close_reason",
    "close_note",
    "voided_by_staff_id",
    "exec_error",
    "recheck_log",
  ],
  guards: Object.fromEntries(
    [
      ["08:523", "refund.submit"],
      ["08:524", "approval.approved"],
      ["08:525", "approval.rejected"],
      ["08:526", "approval.withdrawn"],
      ["08:527", "refund.execute"],
      ["08:528", "refund.record_offline"],
      ["08:529", "refund.complete"],
      ["08:530", "refund.void"],
      ["08:533", "sla.recalculated"],
      ["08:531", "refund.complete"],
      ["08:532", "refund.fail"],
    ].map(([ref, event]) => [rowKey(ref!, event!), guard]),
  ),
};
/** 给既有链只增本包字段/守卫，不替换收款、凭证或发票原守卫。 */
export function withRefundBinding(key: string, base: MachineBinding): MachineBinding {
  if (key === chainKey("billing_order", "status"))
    return {
      ...base,
      companions: [...(base.companions ?? []), "refunded_at"],
      guards: {
        ...base.guards,
        [rowKey("08:177", "billing_order.refund")]: async (tx, f) => {
          const row = await tx.billingOrder.findUnique({
            where: { id: f.subjectId },
            include: { paidPaymentTxn: true },
          });
          return (
            !!row?.paidPaymentTxn?.appliedAt &&
            row.paidPaymentTxn.refundedFen >= row.paidAmountFen &&
            row.refundedAmountFen === row.paidPaymentTxn.refundedFen
          );
        },
      },
    };
  if (key === chainKey("payment_exception", "status"))
    return {
      ...base,
      companions: [
        ...(base.companions ?? []),
        "resolution",
        "resolution_note",
        "resolved_by_staff_id",
        "refund_request_id",
      ],
      guards: {
        ...base.guards,
        [rowKey("08:762", "payment_exception.request_refund")]: async (tx, f) => {
          const id = (f.args as { refundRequestId?: string } | undefined)?.refundRequestId;
          const e = await tx.paymentException.findUnique({ where: { id: f.subjectId } });
          const r = id ? await tx.refundRequest.findUnique({ where: { id } }) : null;
          return (
            !!e &&
            !!r &&
            r.source === "exception" &&
            r.status === "pending_approval" &&
            r.paymentTxnId === e.paymentTxnId &&
            r.entityId === e.entityId &&
            r.breakdownSnapshot !== null &&
            typeof r.breakdownSnapshot === "object" &&
            !Array.isArray(r.breakdownSnapshot) &&
            r.breakdownSnapshot.paymentExceptionId === e.id
          );
        },
        [rowKey("08:763", "payment_exception.complete_refund")]: async (tx, f) => {
          const e = await tx.paymentException.findUnique({
            where: { id: f.subjectId },
            include: { refundRequest: true },
          });
          return e?.refundRequest?.status === "done";
        },
        [rowKey("08:764", "payment_exception.reopen")]: async (tx, f) => {
          const e = await tx.paymentException.findUnique({
            where: { id: f.subjectId },
            include: { refundRequest: true },
          });
          return e?.refundRequest?.status === "not_executed";
        },
      },
    };
  return base;
}
