import { AppError } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { RefundDeps, LockedRefund } from "../refund/context.js";
import { wechatReceiptMatches } from "../payment/channel-success.js";

export const STAGING_REFUND_JOB = "stg.pay.autorefund";
export const STAGING_REFUND_KIND = "staging_pay_refund";
export function assertSystemActor(deps: RefundDeps, ctx: IdentityContext) {
  if (
    deps.stagingPay?.APP_ENV !== "stg" ||
    !deps.stagingPay.STAGING_PAY?.entityIds.length ||
    ctx.actor.type !== "system" ||
    ctx.actor.job !== STAGING_REFUND_JOB
  )
    throw new AppError("PERMISSION_DENIED");
}
/** 每次消费、执行或恢复都回读真实订单/收款；不能凭事件或旧意图放行。 */
export async function stagingOrder(
  tx: Tx,
  deps: RefundDeps,
  ctx: IdentityContext,
  orderId: string,
) {
  assertSystemActor(deps, ctx);
  const order = await tx.billingOrder.findUnique({ where: { id: orderId } });
  if (
    !order ||
    !deps.stagingPay!.STAGING_PAY!.entityIds.includes(order.entityId) ||
    ctx.entityId !== order.entityId ||
    !order.orderNo.startsWith("TFK") ||
    !Number.isInteger(order.amountFen) ||
    order.amountFen < 1 ||
    order.amountFen > 100 ||
    order.channel !== "wechat_jsapi" ||
    !["plan_new", "plan_renew"].includes(order.type) ||
    !["paid", "refunded"].includes(order.status) ||
    order.fulfillmentStatus !== "done" ||
    !order.paidPaymentTxnId ||
    !order.appliedAt ||
    !order.paidAt ||
    order.hasOpenException ||
    order.paidAmountFen !== order.amountFen
  )
    throw new AppError("PRECONDITION_CHANGED");
  const receipt = await tx.paymentTxn.findUnique({ where: { id: order.paidPaymentTxnId } });
  if (
    !receipt ||
    receipt.billingOrderId !== order.id ||
    receipt.entityId !== order.entityId ||
    receipt.status !== "succeeded" ||
    receipt.channel !== "wechat_jsapi" ||
    receipt.amountFen !== order.amountFen ||
    receipt.channelAmountFen !== order.amountFen ||
    !receipt.channelSuccessAt ||
    !receipt.appliedAt ||
    !receipt.channelTxnNo ||
    deps.clock.now().getTime() - receipt.channelSuccessAt.getTime() < 600_000 ||
    !wechatReceiptMatches(order, receipt)
  )
    throw new AppError("PRECONDITION_CHANGED");
  return { order, receipt };
}
export async function assertStagingRefund(
  tx: Tx,
  deps: RefundDeps,
  ctx: IdentityContext,
  state: LockedRefund,
) {
  if (!state.request.billingOrderId) throw new AppError("PRECONDITION_CHANGED");
  const { order, receipt } = await stagingOrder(tx, deps, ctx, state.request.billingOrderId);
  if (
    state.request.source !== "staging_probe" ||
    state.approval.kind !== STAGING_REFUND_KIND ||
    state.approval.submitActorType !== "system" ||
    state.approval.submitActorId !== null ||
    state.approval.requesterStaffId !== null ||
    state.approval.requesterStaffGroupId !== null ||
    state.approval.subjectType !== "billing_order" ||
    state.approval.subjectId !== order.id ||
    state.approval.entityId !== order.entityId ||
    state.request.entityId !== order.entityId ||
    state.request.paymentTxnId !== receipt.id ||
    state.request.ruleCode !== "window" ||
    state.request.isOverride ||
    state.request.amountFen !== order.amountFen ||
    state.request.baseAmountFen !== order.amountFen ||
    state.request.executedByStaffId !== null ||
    (state.request.executedAt === null
      ? state.request.isExecutedBySystem
      : !state.request.isExecutedBySystem) ||
    (state.approval.status !== "pending" &&
      (!state.approval.isDecidedBySystem || state.approval.decidedByStaffId !== null))
  )
    throw new AppError("PRECONDITION_CHANGED");
}
