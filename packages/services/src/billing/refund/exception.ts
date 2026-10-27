import { RefundBreakdownSchema, fulfillResultSchema } from "@liyoxi/contract";
import { byEntity } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { approvalOf, assertStaff, OPEN } from "./context.js";
import type { RefundDeps } from "./context.js";
import type { Submission } from "./approval.js";
import { transition } from "./state.js";
export interface ExceptionRefundInput {
  paymentExceptionId: string;
  /** 差异处理入口须在同TX的340锁后复核；旧内部消费者可省略。 */
  expectedVersion?: number;
  note: string;
  serviceTicketId?: string;
  confirm: { exceptionNo: string; amountFen: number };
}
/** W411只消费此同TX窄口：金额/收款/主体从已存在的异常读取，不接收替换字段。 */
export async function submitExceptionRefund(
  tx: Tx,
  deps: RefundDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  input: ExceptionRefundInput,
  idempotencyKey: string | null,
) {
  await assertStaff(tx, deps, ctx, staff, "finance.recon.resolve");
  const first = await tx.paymentException.findFirst({
    where: { id: input.paymentExceptionId, ...byEntity(staff.scope) },
  });
  if (!first || (!first.entityId && staff.scope.kind !== "all") || !first.paymentTxnId)
    throw new AppError("NOT_FOUND");
  if (
    input.note.trim().length < 1 ||
    input.note.length > 200 ||
    input.confirm.exceptionNo !== first.exceptionNo ||
    input.confirm.amountFen !== first.amountFen
  )
    throw new AppError("CONFIRM_MISMATCH");
  const id = uuidv7(),
    receiptBefore = await tx.paymentTxn.findUniqueOrThrow({ where: { id: first.paymentTxnId } });
  const summaryAmount = Math.max(
    0,
    (receiptBefore.channelAmountFen ?? 0) - receiptBefore.refundedFen,
  );
  const approval = await approvalOf(deps).submit(tx, ctx, {
    kind: "plan_refund",
    subjectType: "payment_txn",
    subjectId: first.paymentTxnId,
    ...(first.entityId ? { entityId: first.entityId } : {}),
    idempotencyKey,
    input: {
      requestId: id,
      exceptionId: first.id,
      ctx,
      staff,
      input: { serviceTicketId: input.serviceTicketId, confirm: { amountFen: summaryAmount } },
    } satisfies Submission,
  });
  if (first.billingOrderId) await lockRows(tx, "billing_order", [first.billingOrderId]);
  await lockRows(tx, "payment_txn", [first.paymentTxnId]);
  const refunds = await tx.refundTxn.findMany({
    where: { paymentTxnId: first.paymentTxnId },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "refund_txn",
    refunds.map((t) => t.id),
  );
  const invoices = first.billingOrderId
    ? await tx.invoiceRequest.findMany({
        where: { billingOrderId: first.billingOrderId },
        orderBy: { id: "asc" },
      })
    : [];
  await lockRows(
    tx,
    "invoice_request",
    invoices.map((i) => i.id),
  );
  const exceptions = await tx.paymentException.findMany({
    where: { paymentTxnId: first.paymentTxnId },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "payment_exception",
    exceptions.map((e) => e.id),
  );
  const exception = await tx.paymentException.findUniqueOrThrow({ where: { id: first.id } }),
    receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: first.paymentTxnId } }),
    order = first.billingOrderId
      ? await tx.billingOrder.findUniqueOrThrow({ where: { id: first.billingOrderId } })
      : null;
  if (input.expectedVersion !== undefined && exception.lockVersion !== input.expectedVersion)
    throw new AppError("VERSION_CONFLICT");
  if (
    exception.status !== "open" ||
    exception.paymentTxnId !== receipt.id ||
    exception.entityId !== receipt.entityId ||
    exception.billingOrderId !== receipt.billingOrderId ||
    receipt.status !== "succeeded" ||
    !receipt.channelAmountFen
  )
    throw new AppError("PRECONDITION_CHANGED");
  const blocked =
    exception.kind === "fulfillment_blocked" &&
    order?.fulfillmentStatus === "blocked" &&
    order.paidPaymentTxnId === receipt.id &&
    receipt.appliedAt !== null;
  if (!blocked && receipt.appliedAt !== null) throw new AppError("PRECONDITION_CHANGED");
  if (await tx.refundRequest.count({ where: { paymentTxnId: receipt.id, closedAt: null } }))
    throw new AppError("REFUND_REQUEST_EXISTS");
  const pending = refunds
      .filter((t) => OPEN.includes(t.status))
      .reduce((n, t) => n + t.amountFen, 0),
    amount = receipt.channelAmountFen - receipt.refundedFen - pending;
  if (amount <= 0 || amount !== summaryAmount) throw new AppError("PRECONDITION_CHANGED");
  const rule = blocked ? "fulfillment_blocked" : "unapplied_receipt",
    now = deps.clock.now(),
    fulfill = fulfillResultSchema.safeParse(order?.fulfillmentResult);
  const breakdown = RefundBreakdownSchema.parse({
    v: 1,
    rule,
    refundableFen: amount,
    paymentExceptionId: exception.id,
    exceptionNo: exception.exceptionNo,
    exceptionKind: exception.kind,
    ...(blocked
      ? {
          blockReasonCode:
            fulfill.success && fulfill.data.status === "blocked"
              ? fulfill.data.reasonCode
              : undefined,
        }
      : { unappliedFen: amount }),
  });
  const request = await tx.refundRequest.create({
    data: {
      id,
      approvalRequestId: approval.approvalId,
      source: "exception",
      entityId: receipt.entityId,
      billingOrderId: receipt.billingOrderId,
      paymentTxnId: receipt.id,
      baseAmountFen: amount,
      amountFen: amount,
      ruleCode: rule,
      ruleText: blocked ? "履约受阻，原入账款全额退款" : "未入账收款按真实未退余额退回",
      breakdownSnapshot: breakdown,
      note: input.note.trim(),
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "payment_exception",
    stateField: "status",
    id: exception.id,
    event: "payment_exception.request_refund",
    ref: "08:762",
    args: { refundRequestId: id },
    ...(receipt.entityId ? { entityId: receipt.entityId } : {}),
    set: {
      resolution: "refund",
      resolution_note: input.note.trim(),
      resolved_by_staff_id: staff.staff.id,
      refund_request_id: id,
    },
    audit: {
      stream: "ops",
      category: "refund",
      action: "finance.refund.from_exception",
      summary: "真实异常收款转入退款审批",
      target: { type: "payment_exception", id: exception.id },
    },
    emit: {
      type: "payment_exception.refund_requested",
      payload: { v: 1, paymentExceptionId: exception.id, refundRequestId: id },
      dedupeKey: `payment_exception.refund_requested:${id}`,
    },
  });
  if (blocked)
    for (const invoice of invoices)
      if (invoice.status === "pending")
        await tx.invoiceRequest.update({
          where: { id: invoice.id },
          data: { heldByRefundRequestId: id, updatedAt: now },
        });
  if (input.serviceTicketId && receipt.entityId)
    await deps.approvalRefs.attach(tx, {
      serviceTicketId: input.serviceTicketId,
      approvalRequestId: approval.approvalId,
      entityId: receipt.entityId,
    });
  await transition(tx, deps, ctx, request, {
    event: "refund.submit",
    ref: "08:523",
    action: "submitted",
    created: true,
    payload: { approvalRequestId: approval.approvalId, ruleCode: rule },
  });
  return {
    refundRequestId: id,
    approvalRequestId: approval.approvalId,
    requestNo: approval.requestNo!,
    amountFen: amount,
  };
}
