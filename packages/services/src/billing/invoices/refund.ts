// W4-10 consumes these owned ports in its transaction; no refund lifecycle is implemented here.
import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx, IdentityContext } from "../../kernel/index.js";
import type { InvoiceRuntimeDeps } from "./context.js";
import { cancelInvoiceSla } from "./sla.js";
export async function readInvoiceRefundGuard(tx: Tx, billingOrderId: string) {
  const row = await tx.invoiceRequest.findFirst({
    where: { billingOrderId },
    orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
  });
  return {
    latest: row ? { invoiceRequestId: row.id, requestNo: row.requestNo, status: row.status } : null,
    needsRedInvoice: row?.status === "issued" || row?.status === "red_pending",
  };
}
export async function markInvoiceRedPending(
  tx: Tx,
  deps: Pick<InvoiceRuntimeDeps, "flow">,
  ctx: IdentityContext,
  input: { refundRequestId: string },
) {
  if (ctx.actor.type !== "system") throw new AppError("PERMISSION_DENIED");
  const request = await tx.refundRequest.findUnique({
    where: { id: input.refundRequestId },
    include: { approvalRequest: true },
  });
  if (
    !request ||
    !request.billingOrderId ||
    request.ruleCode === "unapplied_receipt" ||
    !["pending_execution", "executing"].includes(request.status) ||
    request.approvalRequest.status !== "approved"
  )
    throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "billing_order", [request.billingOrderId]);
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: request.billingOrderId } });
  if (
    order.entityId !== request.entityId ||
    order.paidPaymentTxnId !== request.paymentTxnId ||
    request.approvalRequest.kind !== "plan_refund" ||
    request.approvalRequest.subjectType !== "billing_order" ||
    request.approvalRequest.subjectId !== order.id ||
    request.approvalRequest.entityId !== order.entityId
  )
    throw new AppError("PRECONDITION_CHANGED");
  const row = await tx.invoiceRequest.findFirst({
    where: { billingOrderId: order.id, status: "issued" },
  });
  if (!row) return;
  await lockRows(tx, "invoice_request", [row.id]);
  await deps.flow.transition(
    tx,
    { ...ctx, entityId: row.entityId, storeId: null },
    {
      machine: "invoice_request",
      stateField: "status",
      id: row.id,
      event: "invoice.request_red",
      ref: "08:1115",
      audit: {
        stream: "ops",
        category: "invoice",
        action: "billing.invoice.request_red",
        summary: "已批准退款请求红冲",
        target: { type: "invoice_request", id: row.id },
        entityId: row.entityId,
        storeId: null,
      },
      emit: {
        type: "invoice.red_requested",
        payload: { v: 1, invoiceRequestId: row.id, refundRequestId: request.id },
      },
    },
  );
}
export async function cancelInvoiceRed(
  tx: Tx,
  deps: Pick<InvoiceRuntimeDeps, "flow">,
  ctx: IdentityContext,
  input: { refundRequestId: string },
) {
  if (ctx.actor.type !== "system") throw new AppError("PERMISSION_DENIED");
  const request = await tx.refundRequest.findUnique({ where: { id: input.refundRequestId } });
  if (
    !request ||
    !request.billingOrderId ||
    request.ruleCode === "unapplied_receipt" ||
    request.status !== "not_executed"
  )
    throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "billing_order", [request.billingOrderId]);
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: request.billingOrderId } });
  if (order.entityId !== request.entityId || order.paidPaymentTxnId !== request.paymentTxnId)
    throw new AppError("PRECONDITION_CHANGED");
  // Closing an older request cannot erase a red-invoice obligation from a real refund.
  if (order.status !== "paid" || order.refundedAmountFen !== 0) return;
  if (
    await tx.refundRequest.count({
      where: {
        billingOrderId: order.id,
        paymentTxnId: request.paymentTxnId,
        ruleCode: { not: "unapplied_receipt" },
        status: { in: ["pending_execution", "executing"] },
      },
    })
  )
    return;
  const row = await tx.invoiceRequest.findFirst({
    where: { billingOrderId: order.id, status: "red_pending" },
  });
  if (!row) return;
  await lockRows(tx, "invoice_request", [row.id]);
  await deps.flow.transition(
    tx,
    { ...ctx, entityId: row.entityId, storeId: null },
    {
      machine: "invoice_request",
      stateField: "status",
      id: row.id,
      event: "invoice.cancel_red",
      ref: "08:1117",
      audit: {
        stream: "ops",
        category: "invoice",
        action: "billing.invoice.cancel_red",
        summary: "未执行退款关闭后取消红冲",
        target: { type: "invoice_request", id: row.id },
        entityId: row.entityId,
        storeId: null,
      },
      emit: { type: "invoice.red_cancelled", payload: { v: 1, invoiceRequestId: row.id } },
    },
  );
}
export async function rejectInvoiceAfterRefund(
  tx: Tx,
  deps: Pick<InvoiceRuntimeDeps, "flow" | "timers" | "clock">,
  ctx: IdentityContext,
  billingOrderId: string,
) {
  if (ctx.actor.type !== "system") throw new AppError("PERMISSION_DENIED");
  await lockRows(tx, "billing_order", [billingOrderId]);
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: billingOrderId } });
  if (order.status !== "refunded" || order.refundedAmountFen < order.paidAmountFen)
    throw new AppError("PRECONDITION_CHANGED");
  const row = await tx.invoiceRequest.findFirst({ where: { billingOrderId, status: "pending" } });
  if (!row) return;
  await lockRows(tx, "invoice_request", [row.id]);
  await deps.flow.transition(
    tx,
    { ...ctx, entityId: row.entityId, storeId: null },
    {
      machine: "invoice_request",
      stateField: "status",
      id: row.id,
      event: "invoice.reject_refunded",
      ref: "08:1114",
      set: {
        reject_kind: "order_refunded",
        reject_reason_code: null,
        reject_note: null,
        rejected_by_staff_id: null,
        rejected_at: deps.clock.now(),
      },
      audit: {
        stream: "ops",
        category: "invoice",
        action: "billing.invoice.reject_refunded",
        summary: "付款单退款后驳回开票申请",
        target: { type: "invoice_request", id: row.id },
        entityId: row.entityId,
        storeId: null,
      },
      emit: {
        type: "invoice.rejected",
        payload: {
          v: 1,
          invoiceRequestId: row.id,
          entityId: row.entityId,
          rejectKind: "order_refunded",
        },
      },
    },
  );
  await cancelInvoiceSla(tx, deps.timers, row.id);
}
