import { markInvoiceRedPending } from "../invoices/refund.js";
import { RefundBreakdownSchema } from "@liyoxi/contract";
import type { RefundCreateBody } from "@liyoxi/contract";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { StaffContext } from "../../authz/index.js";
import { defineApprovalKind } from "../../approval/index.js";
import type { ApprovalRow } from "../../approval/index.js";
import { paramsAt } from "../../config/index.js";
import type { SlaPolicy } from "@liyoxi/shared/workcal";
import { workHoursAt } from "../../sla/index.js";
import { orderInScope } from "../payment/purchase-read.js";
import { approvalOf, assertStaff, lockRefund, refundable, termsOf } from "./context.js";
import type { RefundDeps, LockedRefund } from "./context.js";
import { quote } from "./quote.js";
import { executionTimer, restore, system, transition } from "./state.js";

const texts = {
  window: "开通或续费7天内且未使用积分（含冻结），全额退款",
  qualification_failed: "主体资质终审不通过且未使用积分，全额退款",
  override: "规则外全额退款，按审批回收剩余权益",
};
export interface Submission {
  requestId: string;
  input: Pick<RefundCreateBody, "serviceTicketId"> & { confirm: { amountFen: number } };
  exceptionId?: string;
  ctx: IdentityContext;
  staff: StaffContext;
}
export async function recheck(tx: Tx, deps: RefundDeps, state: LockedRefund) {
  const breakdown = RefundBreakdownSchema.parse(state.request.breakdownSnapshot),
    reasons: string[] = [];
  if (state.request.entityId) await deps.ledger.lockAccount(tx, state.request.entityId);
  const terms = termsOf(deps);
  const facts = "termId" in breakdown ? await terms.previewPlanRefund(tx, breakdown.termId) : null;
  const cashOnly =
    state.order?.type === "plan_upgrade" &&
    facts &&
    ["refunded", "cancelled"].includes(facts.termStatus) &&
    state.request.ruleCode === "override";
  if (facts && !cashOnly) {
    const term = await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: facts.termId } });
    if (term.refundRequestId !== state.request.id && !state.request.entitlementRevokedAt)
      reasons.push("term_not_refundable");
    if (state.request.ruleCode !== "override" && !facts.unused) reasons.push("points_used");
    if (state.request.ruleCode !== "override" && facts.upgraded) reasons.push("term_upgraded");
  }
  if (state.request.amountFen > refundable(state)) reasons.push("insufficient_refundable");
  if (state.request.ruleCode === "unapplied_receipt" && state.receipt.appliedAt)
    reasons.push("receipt_applied");
  if (
    state.request.ruleCode === "fulfillment_blocked" &&
    state.order?.fulfillmentStatus !== "blocked"
  )
    reasons.push("fulfillment_changed");
  return {
    at: deps.clock.now().toISOString(),
    eligible: reasons.length === 0,
    reasons,
    usageOk: facts?.unused ?? true,
    upgraded: facts?.upgraded ?? false,
    refundableFen: refundable(state),
  };
}
function logOf(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function refundApproval(current: () => RefundDeps) {
  async function close(tx: Tx, row: ApprovalRow, action: "rejected" | "withdrawn") {
    const deps = current(),
      request = await tx.refundRequest.findUniqueOrThrow({ where: { approvalRequestId: row.id } });
    const state = await lockRefund(tx, request.id);
    await transition(tx, deps, system(request, `billing.refund_${action}`), request, {
      event: `approval.${action}`,
      ref: action === "rejected" ? "08:525" : "08:526",
      action,
      set: { close_reason: action, closed_at: deps.clock.now() },
    });
    await restore(tx, deps, system(request), state);
  }
  return defineApprovalKind<Submission>({
    category: "approval",
    domain: { table: "refund_request", column: "approval_request_id" },
    viewModules: ["finance", "order"],
    decidePermission: "finance.refund.approve",
    groupBound: false,
    hasExecution: true,
    numberPrefix: "TK",
    operations: {
      get: "admin.refundRequest.get",
      approve: "admin.refundRequest.approve",
      reject: "admin.refundRequest.reject",
      withdraw: "admin.refundRequest.withdraw",
    },
    validate: async (tx, s) => {
      const deps = current();
      if (s.input.ctx.actor.id !== s.input.staff.staff.id) throw new AppError("PERMISSION_DENIED");
      if (s.input.exceptionId) {
        await assertStaff(tx, deps, s.input.ctx, s.input.staff, "finance.recon.resolve");
        const exception = await tx.paymentException.findUnique({
          where: { id: s.input.exceptionId },
        });
        if (
          !exception ||
          s.subjectType !== "payment_txn" ||
          s.subjectId !== exception.paymentTxnId ||
          exception.entityId !== s.entityId ||
          (!s.entityId && s.input.staff.scope.kind !== "all")
        )
          throw new AppError("NOT_FOUND");
      } else {
        if (s.subjectType !== "billing_order" || !s.entityId)
          throw new AppError("VALIDATION_FAILED");
        const order = await orderInScope(tx, s.input.staff.scope, s.subjectId);
        if (order.entityId !== s.entityId) throw new AppError("NOT_FOUND");
      }
      if (s.input.input.serviceTicketId) {
        if (!s.entityId) throw new AppError("NOT_FOUND");
        await deps.approvalRefs.prepare(tx, {
          serviceTicketId: s.input.input.serviceTicketId,
          entityId: s.entityId,
        });
      }
    },
    summarize: async (_tx, s) => ({
      title: s.input.exceptionId ? "异常收款退款" : "套餐现金退款",
      amountFen: s.input.input.confirm.amountFen,
      domain: { type: "refund_request", id: s.input.requestId },
    }),
    revalidate: async (tx, row) => {
      const request = await tx.refundRequest.findUniqueOrThrow({
        where: { approvalRequestId: row.id },
      });
      const state = await lockRefund(tx, request.id),
        result = await recheck(tx, current(), state);
      if (!result.eligible)
        throw new AppError("PRECONDITION_CHANGED", { details: { reasons: result.reasons } });
      await tx.refundRequest.update({
        where: { id: request.id },
        data: { recheckLog: { ...logOf(request.recheckLog), approve: result } },
      });
    },
    onApproved: async (tx, row) => {
      const deps = current(),
        request = await tx.refundRequest.findUniqueOrThrow({
          where: { approvalRequestId: row.id },
        });
      const state = await lockRefund(tx, request.id),
        now = deps.clock.now();
      const values = await paramsAt(tx, ["sla.review.refund_execute"], now),
        policy = values["sla.review.refund_execute"] as SlaPolicy;
      const due = await deps.sla.dueAt(tx, {
        policy: "review.refund_execute",
        from: now,
        amount: policy.amount,
        unit: policy.unit,
        workHours: await workHoursAt(tx, now),
      });
      await transition(tx, deps, system(request, "billing.refund_approved"), request, {
        event: "approval.approved",
        ref: "08:524",
        action: "approved",
        set: { exec_due_at: due.dueAt, sla_snapshot: due.snapshot },
      });
      await executionTimer(tx, deps, state, due.dueAt);
      if (state.receipt.appliedAt && state.order?.paidPaymentTxnId === state.receipt.id)
        await markInvoiceRedPending(tx, deps, system(request), { refundRequestId: request.id });
    },
    onRejected: (tx, row) => close(tx, row, "rejected"),
    onWithdrawn: (tx, row) => close(tx, row, "withdrawn"),
    executionSla: async (tx, row) => {
      const request = await tx.refundRequest.findUnique({ where: { approvalRequestId: row.id } });
      return request
        ? {
            status: request.status,
            dueAt: request.execDueAt,
            hasExecuted: request.executedAt !== null,
          }
        : null;
    },
  });
}
export async function submitRefund(
  tx: Tx,
  deps: RefundDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  orderId: string,
  input: RefundCreateBody,
  idempotencyKey: string | null,
) {
  await assertStaff(tx, deps, ctx, staff, "order.refund.request");
  if (input.ruleCode === "override")
    await assertStaff(tx, deps, ctx, staff, "refund.override.request");
  const first = await orderInScope(tx, staff.scope, orderId),
    id = uuidv7();
  const approval = await approvalOf(deps).submit(tx, ctx, {
    kind: "plan_refund",
    subjectType: "billing_order",
    subjectId: orderId,
    entityId: first.entityId,
    idempotencyKey,
    input: { requestId: id, input, ctx, staff } satisfies Submission,
  });
  await lockRows(tx, "billing_order", [orderId]);
  const order = await orderInScope(tx, staff.scope, orderId);
  if (order.paidPaymentTxnId) await lockRows(tx, "payment_txn", [order.paidPaymentTxnId]);
  const invoices = await tx.invoiceRequest.findMany({
    where: { billingOrderId: orderId },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "invoice_request",
    invoices.map((i) => i.id),
  );
  await deps.ledger.lockAccount(tx, order.entityId);
  const calculated = await quote(tx, deps, staff, order, input.ruleCode);
  if (!calculated.supported)
    throw new AppError(
      calculated.unsupportedReason === "open_request_exists"
        ? "REFUND_REQUEST_EXISTS"
        : "REFUND_NOT_SUPPORTED",
      { details: { reasonCode: calculated.unsupportedReason } },
    );
  const rule = calculated.rules.find((r) => r.rule === input.ruleCode);
  if (!rule?.eligible || !calculated.term || !order.paidPaymentTxnId)
    throw new AppError("PLAN_REFUND_NOT_ELIGIBLE", {
      details: { rule: input.ruleCode, reasons: rule?.reasons },
    });
  if (
    input.confirm.orderNo !== order.orderNo ||
    input.confirm.amountFen !== calculated.refundableFen
  )
    throw new AppError("CONFIRM_MISMATCH");
  if (
    !(await tx.dictItem.findFirst({
      where: { dictTypeKey: "refund_reason", code: input.reasonCode, isEnabled: true },
    }))
  )
    throw new AppError("DICT_ITEM_DISABLED");
  const facts = await termsOf(deps).previewPlanRefund(tx, calculated.term.subscriptionTermId);
  const now = deps.clock.now();
  const cashOnly =
    order.type === "plan_upgrade" && ["refunded", "cancelled"].includes(facts.termStatus);
  const breakdown = RefundBreakdownSchema.parse(
    cashOnly
      ? {
          v: 1,
          rule: "override",
          refundableFen: calculated.refundableFen,
          sourceTermId: facts.termId,
          cashOnly: true,
        }
      : {
          v: 1,
          rule: input.ruleCode,
          ...facts,
          refundableFen: calculated.refundableFen,
        },
  );
  const request = await tx.refundRequest.create({
    data: {
      id,
      approvalRequestId: approval.approvalId,
      source: "customer_service",
      entityId: order.entityId,
      billingOrderId: order.id,
      paymentTxnId: order.paidPaymentTxnId,
      baseAmountFen: calculated.refundableFen,
      amountFen: calculated.refundableFen,
      ruleCode: input.ruleCode,
      ruleText: texts[input.ruleCode],
      isOverride: input.ruleCode === "override",
      reasonCode: input.reasonCode,
      note: input.note ?? null,
      status: "pending_approval",
      breakdownSnapshot: breakdown,
      createdAt: now,
      updatedAt: now,
    },
  });
  // M111：来源款已回收整个周期之后，升级补差的override只退现金，不再挂闸门。
  if (!cashOnly)
    await termsOf(deps).suspendTermForRefund(tx, ctx, {
      termId: facts.termId,
      refundRequestId: id,
      requestNo: approval.requestNo!,
      rule: input.ruleCode,
    });
  for (const invoice of invoices)
    if (invoice.status === "pending")
      await tx.invoiceRequest.update({
        where: { id: invoice.id },
        data: { heldByRefundRequestId: id, updatedAt: now },
      });
  if (input.serviceTicketId)
    await deps.approvalRefs.attach(tx, {
      serviceTicketId: input.serviceTicketId,
      approvalRequestId: approval.approvalId,
      entityId: order.entityId,
    });
  await transition(tx, deps, ctx, request, {
    event: "refund.submit",
    ref: "08:523",
    action: "submitted",
    created: true,
    payload: { approvalRequestId: approval.approvalId, ruleCode: input.ruleCode },
  });
  return request.id;
}
