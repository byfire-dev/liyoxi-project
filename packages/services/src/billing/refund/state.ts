import { z } from "zod";
import { cancelInvoiceRed } from "../invoices/refund.js";
import { PAYMENT_EXCEPTION_RESOLUTION } from "@liyoxi/contract/enums";
import type { RefundRequest } from "@liyoxi/db";
import { createIdentityContext } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { RefundDeps, LockedRefund } from "./context.js";
import { termsOf } from "./context.js";

export const system = (request: Pick<RefundRequest, "entityId">, job = "billing.refund_result") =>
  createIdentityContext({
    actor: { type: "system", job },
    ...(request.entityId ? { entityId: request.entityId } : {}),
  });
export async function transition(
  tx: Tx,
  deps: RefundDeps,
  ctx: IdentityContext,
  request: RefundRequest,
  input: {
    event: string;
    ref: string;
    action: string;
    created?: boolean;
    set?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  },
) {
  await deps.flow.transition(tx, ctx, {
    machine: "refund_request",
    stateField: "status",
    id: request.id,
    event: input.event,
    ref: input.ref,
    ...(input.created ? { created: true } : {}),
    ...(request.entityId ? { entityId: request.entityId } : {}),
    set: input.set,
    audit: {
      stream: "ops",
      category: "refund",
      action: `finance.refund.${input.action}`,
      summary: "现金退款状态变更",
      target: { type: "refund_request", id: request.id },
    },
    emit: {
      type: `refund.${input.action}`,
      payload: {
        v: 1,
        refundRequestId: request.id,
        ...(["submitted", "rejected", "completed"].includes(input.action)
          ? { billingOrderId: request.billingOrderId }
          : {}),
        ...(["rejected", "completed"].includes(input.action) ? { entityId: request.entityId } : {}),
        ...(["submitted", "completed"].includes(input.action)
          ? { amountFen: request.amountFen }
          : {}),
        ...(input.action === "approved" && input.set?.exec_due_at instanceof Date
          ? { execDueAt: input.set.exec_due_at.toISOString() }
          : {}),
        ...input.payload,
      },
      dedupeKey: `refund.${input.action}:${request.id}:${request.lockVersion}`,
    },
  });
}
export async function executionTimer(tx: Tx, deps: RefundDeps, state: LockedRefund, dueAt?: Date) {
  const subject = { type: "approval_request", id: state.approval.id };
  if (!dueAt)
    return deps.timers.cancel(tx, {
      subject,
      kinds: ["sla.breach"],
      keyPrefix: `sla.breach:approval_request:${state.approval.id}:execution`,
    });
  await deps.timers.arm(tx, {
    kind: "sla.breach",
    subject,
    key: `sla.breach:approval_request:${state.approval.id}:execution`,
    fireAt: dueAt,
    payload: { purpose: "execution", dueAt: dueAt.toISOString() },
    ...(state.request.entityId ? { entityId: state.request.entityId } : {}),
  });
}
export async function restore(tx: Tx, deps: RefundDeps, ctx: IdentityContext, state: LockedRefund) {
  const request = state.request;
  const term = await tx.subscriptionTerm.findFirst({ where: { refundRequestId: request.id } });
  // 先恢复开票/差异，再取账户最后锁；恢复闸门不搬回任何已消费或已回收积分。
  if (
    request.ruleCode !== "unapplied_receipt" &&
    state.receipt.appliedAt &&
    state.order?.paidPaymentTxnId === state.receipt.id
  )
    await cancelInvoiceRed(tx, deps, system(request), { refundRequestId: request.id });
  for (const invoice of state.invoices) {
    if (invoice.heldByRefundRequestId !== request.id) continue;
    await tx.invoiceRequest.update({
      where: { id: invoice.id },
      data: { heldByRefundRequestId: null, updatedAt: deps.clock.now() },
    });
  }
  for (const exception of state.exceptions) {
    if (exception.refundRequestId !== request.id || exception.status !== "resolving") continue;
    await deps.flow.transition(tx, ctx, {
      machine: "payment_exception",
      stateField: "status",
      id: exception.id,
      audit: {
        stream: "ops",
        category: "refund",
        action: "finance.refund.reopen_exception",
        summary: "退款未执行关闭后恢复真实差异待办",
        target: { type: "payment_exception", id: exception.id },
      },
      event: "payment_exception.reopen",
      ref: "08:764",
      ...(request.entityId ? { entityId: request.entityId } : {}),
      set: {
        resolution: "none",
        resolution_note: null,
        resolved_by_staff_id: null,
        refund_request_id: null,
      },
      emit: {
        type: "payment_exception.reopened",
        payload: { v: 1, paymentExceptionId: exception.id },
        dedupeKey: `payment_exception.reopened:${request.id}:${exception.id}`,
      },
    });
  }
  if (term) {
    await termsOf(deps).resumeTermFromRefund(tx, ctx, {
      termId: term.id,
      refundRequestId: request.id,
      requestNo: state.approval.requestNo!,
    });
  }
}
export async function failed(
  tx: Tx,
  deps: RefundDeps,
  state: LockedRefund,
  txnId: string,
  status: "closed" | "not_accepted" | "abandoned",
) {
  if (state.request.status !== "executing") return;
  await transition(tx, deps, system(state.request), state.request, {
    event: "refund.fail",
    ref: "08:532",
    action: "execution_failed",
    set: {
      exec_error: {
        at: deps.clock.now().toISOString(),
        refundTxnId: txnId,
        code: status,
        message: "渠道退款未完成，权益回收事实保留",
      },
    },
    payload: { refundTxnId: txnId, txnStatus: status },
  });
}
export async function completed(tx: Tx, deps: RefundDeps, state: LockedRefund, offline = false) {
  const request = await tx.refundRequest.findUniqueOrThrow({ where: { id: state.request.id } });
  if (!["executing", "pending_execution"].includes(request.status)) return false;
  if (
    await tx.refundTxn.count({
      where: { refundRequestId: request.id, status: { in: ["created", "processing", "abnormal"] } },
    })
  )
    return false;
  const total = await tx.refundTxn.aggregate({
    where: { refundRequestId: request.id, status: "succeeded" },
    _sum: { amountFen: true },
  });
  if ((total._sum.amountFen ?? 0) < request.amountFen) return false;
  const now = deps.clock.now();
  await transition(tx, deps, system(request), request, {
    event: offline ? "refund.record_offline" : "refund.complete",
    ref: offline ? "08:528" : request.status === "executing" ? "08:531" : "08:529",
    action: "completed",
    set: { done_at: now, closed_at: now, exec_error: null },
  });
  for (const invoice of state.invoices)
    if (invoice.heldByRefundRequestId === request.id)
      await tx.invoiceRequest.update({
        where: { id: invoice.id },
        data: { heldByRefundRequestId: null, updatedAt: now },
      });
  for (const exception of state.exceptions)
    if (exception.refundRequestId === request.id && exception.status === "resolving")
      await deps.flow.transition(tx, system(request), {
        machine: "payment_exception",
        stateField: "status",
        id: exception.id,
        audit: {
          stream: "ops",
          category: "refund",
          action: "finance.refund.resolve_exception",
          summary: "真实退款成功关闭关联差异",
          target: { type: "payment_exception", id: exception.id },
        },
        event: "payment_exception.complete_refund",
        ref: "08:763",
        ...(request.entityId ? { entityId: request.entityId } : {}),
        set: { resolved_at: now },
        emit: {
          type: "payment_exception.resolved",
          payload: {
            v: 1,
            paymentExceptionId: exception.id,
            resolution: z.enum(PAYMENT_EXCEPTION_RESOLUTION.values).parse(exception.resolution),
          },
          dedupeKey: `payment_exception.resolved:${exception.id}`,
        },
      });
  if (state.order)
    await tx.billingOrder.update({
      where: { id: state.order.id },
      data: {
        hasOpenException:
          (await tx.paymentException.count({
            where: { billingOrderId: state.order.id, status: { in: ["open", "resolving"] } },
          })) > 0,
        updatedAt: now,
      },
    });
  if (!deps.approval) throw new TypeError("退款缺审批运行时");
  await deps.approval.recordExecuted(tx, system(request), {
    approvalId: request.approvalRequestId,
    domain: { type: "refund_request", id: request.id },
  });
  return true;
}
