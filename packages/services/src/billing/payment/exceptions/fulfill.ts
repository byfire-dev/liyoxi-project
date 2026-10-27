import { BILLING_ORDER_TYPE, PAY_CHANNEL, z, zodEnum } from "@liyoxi/contract";
import type { PaymentExceptionResolveBody } from "@liyoxi/contract";
import type { BillingOrder } from "@liyoxi/db";
import { record } from "../../../audit/index.js";
import type { StaffContext } from "../../../authz/index.js";
import { AppError } from "../../../kernel/index.js";
import type { IdentityContext, Tx } from "../../../kernel/index.js";
import { fulfillOpKey } from "../../subscription/index.js";
import { openPaymentException } from "../exception.js";
import { cancelTransferSla } from "../transfer-sla.js";
import type { LockedException, PaymentExceptionDeps } from "./context.js";

export async function fulfill(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  order: BillingOrder,
  input: PaymentExceptionResolveBody,
) {
  const { result } = await deps.fulfillment.fulfill(tx, { billingOrderId: order.id, ctx });
  const doneAt =
    result.status === "done"
      ? (await tx.ledgerOperation.findUniqueOrThrow({ where: { opKey: fulfillOpKey(order.id) } }))
          .occurredAt
      : null;
  await tx.billingOrder.update({
    where: { id: order.id },
    data: {
      fulfillmentStatus: result.status,
      fulfillmentResult: z.record(z.string(), z.json()).parse(result),
      fulfilledAt: doneAt,
      fulfillmentNote:
        result.status === "blocked" ? result.reasonCode : result.notes.join(", ") || null,
      updatedAt: deps.clock.now(),
    },
  });
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: "ops",
      category: "recon",
      action: `finance.payment_exception.${input.resolution}`,
      summary: input.note,
      target: { type: "billing_order", id: order.id },
      entityId: order.entityId,
      storeId: order.storeId,
      meta: { fulfillmentStatus: result.status },
    },
  );
  return result;
}
export async function retry(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  state: LockedException,
  input: PaymentExceptionResolveBody,
) {
  const order = state.order,
    receipt = state.receipt;
  if (
    !order ||
    !receipt?.appliedAt ||
    order.paidPaymentTxnId !== receipt.id ||
    order.status !== "paid" ||
    order.fulfillmentStatus !== "blocked"
  )
    throw new AppError("STATE_NOT_ALLOWED");
  return fulfill(tx, deps, ctx, order, input);
}
export async function recordBlocked(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  order: BillingOrder,
) {
  if (!order.paidPaymentTxnId) throw new AppError("INTERNAL");
  const receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: order.paidPaymentTxnId } });
  const id = await openPaymentException(tx, deps, ctx, {
    kind: "fulfillment_blocked",
    order,
    receipt,
  });
  await deps.events.emit(tx, ctx, {
    type: "billing_order.fulfillment_blocked",
    aggregate: { type: "billing_order", id: order.id },
    entityId: order.entityId,
    storeId: order.storeId,
    payload: { v: 1, billingOrderId: order.id, entityId: order.entityId, paymentExceptionId: id },
    dedupeKey: `billing_order.fulfillment_blocked:${order.id}`,
  });
}
/** 显式补单/关联使用正式迁移；普通applyPayment保持取消后仅开差异的语义。 */
export async function pay(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  state: LockedException,
  input: PaymentExceptionResolveBody,
) {
  const { order, receipt, exception } = state;
  if (
    !order ||
    !receipt ||
    receipt.status !== "succeeded" ||
    receipt.appliedAt ||
    receipt.refundedFen !== 0 ||
    receipt.channelAmountFen !== order.amountFen ||
    !receipt.channelSuccessAt
  )
    throw new AppError("PRECONDITION_CHANGED");
  const now = deps.clock.now();
  await deps.flow.transition(tx, ctx, {
    machine: "billing_order",
    stateField: "status",
    id: order.id,
    event: input.resolution === "restore" ? "billing_order.restore" : "billing_order.link_receipt",
    ref: input.resolution === "restore" ? "08:176" : "08:174",
    args: { paymentTxnId: receipt.id, paymentExceptionId: exception.id },
    entityId: order.entityId,
    storeId: order.storeId,
    set: {
      paid_amount_fen: receipt.channelAmountFen,
      paid_at: receipt.channelSuccessAt,
      paid_payment_txn_id: receipt.id,
      applied_at: now,
      transfer_state: null,
    },
    audit: {
      stream: "ops",
      category: "recon",
      action: `finance.payment_exception.${input.resolution}`,
      summary: input.note,
      target: { type: "billing_order", id: order.id },
    },
    emit: {
      type: "billing_order.paid",
      payload: {
        v: 1,
        billingOrderId: order.id,
        entityId: order.entityId,
        storeId: order.storeId,
        orderType: zodEnum(BILLING_ORDER_TYPE).parse(order.type),
        channel: zodEnum(PAY_CHANNEL).parse(receipt.channel),
        amountFen: receipt.channelAmountFen,
        paidPaymentTxnId: receipt.id,
        placedByUserId: order.placedByUserId,
      },
      dedupeKey: `billing_order.paid:${order.id}`,
    },
  });
  await tx.paymentTxn.update({
    where: { id: receipt.id },
    data: { appliedAt: now, updatedAt: now },
  });
  if (input.resolution === "link_order") {
    const pending = state.proofs.filter((p) => p.reviewStatus === "pending");
    for (const proof of pending) {
      await tx.transferProof.update({
        where: { id: proof.id },
        data: {
          reviewStatus: "accepted",
          reviewedByStaffId: staff.staff.id,
          reviewedAt: now,
          lockVersion: { increment: 1 },
          updatedAt: now,
        },
      });
      await cancelTransferSla(tx, deps.timers, proof.id);
    }
    if (pending[0])
      await tx.paymentTxn.update({
        where: { id: receipt.id },
        data: { transferProofId: pending[0].id, updatedAt: now },
      });
  }
  const result = await fulfill(tx, deps, ctx, order, input);
  if (result.status === "blocked") {
    await recordBlocked(
      tx,
      deps,
      ctx,
      await tx.billingOrder.findUniqueOrThrow({ where: { id: order.id } }),
    );
  }
  await deps.timers.cancel(tx, {
    subject: { type: "billing_order", id: order.id },
    kinds: [receipt.channel === "wechat_jsapi" ? "po.expire" : "po.transfer_ttl"],
  });
  return result;
}
