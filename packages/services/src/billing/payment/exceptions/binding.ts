import type { PaymentExceptionKindCode } from "@liyoxi/contract";
import { chainKey, rowKey } from "../../../flow/index.js";
import type { Guard, MachineBinding } from "../../../flow/index.js";
import { wechatReceiptMatches } from "../channel-success.js";
import { MATRIX } from "./matrix.js";

const resolved: Guard = async (tx, f) => {
  if (f.ctx.actor.type !== "staff") return false;
  const row = await tx.paymentException.findUnique({
    where: { id: f.subjectId },
    include: { billingOrder: true, paymentTxn: true, refundTxn: true },
  });
  const resolution = (f.args as { resolution?: string } | undefined)?.resolution;
  if (
    !row ||
    row.status !== "open" ||
    !resolution ||
    !(MATRIX[row.kind as PaymentExceptionKindCode] ?? []).some((r) => r === resolution) ||
    (row.kind === "bill_only" && row.billingOrderId && resolution !== "rebuild_order")
  )
    return false;
  switch (resolution) {
    case "retried":
      return (
        row.kind === "fulfillment_blocked" &&
        row.billingOrder?.fulfillmentStatus === "done" &&
        row.paymentTxn?.appliedAt !== null
      );
    case "restore":
    case "rebuild_order":
    case "link_order":
      return (
        row.billingOrder?.status === "paid" &&
        row.billingOrder.paidPaymentTxnId === row.paymentTxnId &&
        !!row.paymentTxn?.appliedAt
      );
    case "offline_return":
      return (
        row.refundTxn?.status === "succeeded" &&
        row.refundTxn.channel === "offline" &&
        row.refundTxn.refundRequestId === null &&
        row.refundTxn.paymentTxnId === row.paymentTxnId
      );
    case "record_channel_refund":
      return (
        row.refundTxn?.status === "succeeded" &&
        row.refundTxn.origin === "external" &&
        row.refundTxn.refundRequestId === null &&
        row.refundTxn.paymentTxnId === row.paymentTxnId
      );
    case "corrected":
    case "written_off":
      return true; // 权限和人工结论由用例在staff20锁后复核；此处不伪造账本更正。
    default:
      return false;
  }
};
const pay: Guard = async (tx, f) => {
  const args = f.args as { paymentTxnId?: string; paymentExceptionId?: string } | undefined;
  const [order, receipt, exception] = await Promise.all([
    tx.billingOrder.findUnique({ where: { id: f.subjectId } }),
    args?.paymentTxnId ? tx.paymentTxn.findUnique({ where: { id: args.paymentTxnId } }) : null,
    args?.paymentExceptionId
      ? tx.paymentException.findUnique({ where: { id: args.paymentExceptionId } })
      : null,
  ]);
  return (
    !!order &&
    !!receipt &&
    !!exception &&
    f.ctx.actor.type === "staff" &&
    exception.status === "open" &&
    exception.paymentTxnId === receipt.id &&
    exception.billingOrderId === order.id &&
    receipt.status === "succeeded" &&
    receipt.appliedAt === null &&
    receipt.billingOrderId === order.id &&
    receipt.entityId === order.entityId &&
    receipt.channel === order.channel &&
    receipt.channelAmountFen === order.amountFen &&
    receipt.refundedFen === 0 &&
    wechatReceiptMatches(order, receipt) &&
    (f.event === "billing_order.restore"
      ? exception.kind === "paid_after_cancel" && order.status === "cancelled"
      : exception.kind === "bank_unmatched" &&
        order.channel === "bank_transfer" &&
        ["pending_payment", "pending_confirmation"].includes(order.status) &&
        order.transferState !== "confirm_review")
  );
};
/** 仅补本包正式迁移，不替换入账/退款/发票原守卫。 */
export function withPaymentExceptionBinding(key: string, base: MachineBinding): MachineBinding {
  if (key === chainKey("payment_exception", "status"))
    return {
      ...base,
      guards: {
        ...base.guards,
        [rowKey("08:765", "payment_exception.retry_fulfill")]: resolved,
        [rowKey("08:766", "payment_exception.resolve")]: resolved,
      },
    };
  if (key === chainKey("billing_order", "status"))
    return {
      ...base,
      guards: {
        ...base.guards,
        [rowKey("08:174", "billing_order.link_receipt")]: pay,
        [rowKey("08:176", "billing_order.restore")]: pay,
        [rowKey("08:178", "billing_order.rebuild")]: async (tx, f) => {
          const id = (f.args as { paymentExceptionId?: string } | undefined)?.paymentExceptionId;
          const order = await tx.billingOrder.findUnique({
            where: { id: f.subjectId },
            include: { paidPaymentTxn: true },
          });
          const e = id ? await tx.paymentException.findUnique({ where: { id } }) : null;
          const receipt = order?.paidPaymentTxn;
          return (
            !!order &&
            !!receipt &&
            !!e &&
            f.ctx.actor.type === "staff" &&
            order.createdByStaffId === f.ctx.actor.id &&
            order.placedByUserId === null &&
            order.source === "weapp" &&
            order.channel === "wechat_jsapi" &&
            ["plan_new", "plan_renew", "topup"].includes(order.type) &&
            order.rebuiltFrom === receipt.outTradeNo &&
            e.kind === "bill_only" &&
            e.status === "open" &&
            e.paymentTxnId === receipt.id &&
            e.billingOrderId === order.id &&
            e.entityId === order.entityId &&
            receipt.status === "succeeded" &&
            receipt.appliedAt !== null &&
            receipt.billingOrderId === order.id &&
            receipt.entityId === order.entityId &&
            receipt.channelAmountFen === order.amountFen &&
            order.paidAmountFen === receipt.channelAmountFen &&
            receipt.refundedFen === 0 &&
            wechatReceiptMatches(order, receipt)
          );
        },
      },
    };
  return base;
}
