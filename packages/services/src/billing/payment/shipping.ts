// 只用永久收款行表达受理事实；通用幂等过期/投递换代不能授予再次发货机会。
import type { BillingOrder, PaymentTxn } from "@liyoxi/db";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import type { EventPayloadOf } from "@liyoxi/contract";
import { AppError, lockRows, SessionMutexError } from "../../kernel/index.js";
import type { Clock, DeliveredEvent, SessionMutex, Tx, TxRunner } from "../../kernel/index.js";
import type { WechatProvider, WechatShippingOrder } from "../../providers/types.js";
import { financeConfigAt } from "../finance-config/index.js";

export const SHIPPING_SUBSCRIBER = "billing.uploadShippingInfo";
export interface ShippingDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly sessionMutex: SessionMutex | undefined;
  readonly provider: WechatProvider;
  readonly appid: string | undefined;
  readonly paymentAppid: string | undefined;
  readonly mchid: string | undefined;
}
type Paid = EventPayloadOf<"billing_order.paid">;
type Facts = { paid: Paid; order: BillingOrder; receipt: PaymentTxn };
type Intent = {
  readonly appid: string;
  readonly mchid: string;
  readonly description: string;
  readonly uploadedAt: Date;
};
const unavailable = (cause?: unknown) => new AppError("PROVIDER_UNAVAILABLE", { cause });
const invalid = () => new AppError("INTERNAL");
const enabled = async (tx: Tx, clock: Clock) =>
  (await financeConfigAt(tx, clock.now())).controls.shippingReport;

/** 回读真实outbox，不接受调用方拼出的paid载荷作资金证据。 */
async function paidEvent(tx: Tx, event: DeliveredEvent): Promise<Paid> {
  const stored = await tx.outboxEvent.findUnique({ where: { id: event.id } });
  const schema = EVENT_PAYLOAD_SCHEMAS["billing_order.paid"];
  const parsed = schema.safeParse(stored?.payload);
  const incoming = schema.safeParse(event.payload);
  if (
    event.type !== "billing_order.paid" ||
    stored?.eventType !== "billing_order.paid" ||
    !parsed.success ||
    !incoming.success ||
    parsed.data.toState !== "paid" ||
    JSON.stringify(incoming.data) !== JSON.stringify(parsed.data) ||
    stored.aggregateType !== "billing_order" ||
    stored.aggregateId !== parsed.data.billingOrderId
  )
    throw invalid();
  return parsed.data;
}
async function facts(tx: Tx, event: DeliveredEvent): Promise<Facts> {
  const paid = await paidEvent(tx, event);
  await lockRows(tx, "billing_order", [paid.billingOrderId]);
  await lockRows(tx, "payment_txn", [paid.paidPaymentTxnId]);
  const order = await tx.billingOrder.findUnique({ where: { id: paid.billingOrderId } });
  const receipt = await tx.paymentTxn.findUnique({ where: { id: paid.paidPaymentTxnId } });
  if (
    !order ||
    !receipt ||
    !["paid", "refunded"].includes(order.status) ||
    !order.appliedAt ||
    !order.paidAt ||
    order.paidPaymentTxnId !== receipt.id ||
    receipt.billingOrderId !== order.id ||
    receipt.entityId !== order.entityId ||
    order.entityId !== paid.entityId ||
    order.storeId !== paid.storeId ||
    order.type !== paid.orderType ||
    order.placedByUserId !== paid.placedByUserId ||
    order.channel !== paid.channel ||
    receipt.channel !== paid.channel ||
    receipt.status !== "succeeded" ||
    !receipt.appliedAt ||
    order.paidAmountFen !== paid.amountFen ||
    receipt.channelAmountFen !== paid.amountFen ||
    order.amountFen !== paid.amountFen
  )
    throw invalid();
  if (
    paid.channel === "wechat_jsapi" &&
    (!receipt.channelTxnNo?.trim() ||
      receipt.channelTxnNo.length > 128 ||
      !receipt.channelPayerRef?.trim() ||
      receipt.channelPayerRef.length > 128 ||
      !receipt.channelSuccessAt)
  )
    throw invalid();
  return { paid, order, receipt };
}
function configuration(deps: ShippingDeps) {
  if (
    !deps.provider.configured ||
    !deps.provider.uploadShippingInfo ||
    !deps.provider.queryShippingInfo ||
    !deps.appid ||
    deps.appid !== deps.paymentAppid ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(deps.appid) ||
    !deps.mchid ||
    !/^[0-9]{6,20}$/.test(deps.mchid)
  )
    throw unavailable();
  return { appid: deps.appid, mchid: deps.mchid };
}
function persisted(row: PaymentTxn): Intent {
  if (
    !row.shippingReportAppid ||
    !row.shippingReportMchid ||
    !row.shippingReportItemDesc ||
    !row.shippingReportUploadTime
  )
    throw invalid();
  return {
    appid: row.shippingReportAppid,
    mchid: row.shippingReportMchid,
    description: row.shippingReportItemDesc,
    uploadedAt: row.shippingReportUploadTime,
  };
}
function sameIntent(row: PaymentTxn, intent: Intent) {
  return (
    row.shippingReportAppid === intent.appid &&
    row.shippingReportMchid === intent.mchid &&
    row.shippingReportItemDesc === intent.description &&
    row.shippingReportUploadTime?.getTime() === intent.uploadedAt.getTime()
  );
}
function matches(order: WechatShippingOrder, facts: Facts, intent: Intent) {
  const { receipt } = facts;
  return (
    order.transactionId === receipt.channelTxnNo &&
    order.outTradeNo === receipt.outTradeNo &&
    order.mchid === intent.mchid &&
    order.payerOpenid === receipt.channelPayerRef &&
    order.amountFen === receipt.channelAmountFen &&
    order.shipping?.logisticsType === 3 &&
    order.shipping.deliveryMode === 1 &&
    order.shipping.finished &&
    order.shipping.items.length === 1 &&
    order.shipping.items[0]?.description === intent.description &&
    order.shipping.items[0].uploadedAtSec === Math.floor(intent.uploadedAt.getTime() / 1000)
  );
}

export function createShipping(deps: ShippingDeps) {
  let stopped = false;
  const active = () => {
    if (stopped) throw new TypeError("发货运行时已关闭");
  };
  async function claim(tx: Tx, event: DeliveredEvent) {
    active();
    if (!(await enabled(tx, deps.clock))) return null;
    const current = await facts(tx, event);
    if (current.paid.channel !== "wechat_jsapi") return null;
    const row = current.receipt;
    if (row.shippingReportState === "confirmed") return null;
    // 已退单只恢复既有未知意图，不再首次报告发货。
    if (
      current.order.status === "refunded" &&
      (row.shippingReportState === null || row.shippingReportState === "not_accepted")
    )
      return null;
    const config = configuration(deps);
    const intent =
      row.shippingReportState === null
        ? {
            ...config,
            description: current.order.type === "topup" ? "狸有戏积分包" : "狸有戏套餐数字服务",
            uploadedAt: deps.clock.now(),
          }
        : persisted(row);
    if (
      config.appid !== intent.appid ||
      config.mchid !== intent.mchid ||
      !Number.isFinite(intent.uploadedAt.getTime()) ||
      !/^\d{4}-/.test(intent.uploadedAt.toISOString())
    )
      throw unavailable();
    const upload = row.shippingReportState === null || row.shippingReportState === "not_accepted";
    if (upload) {
      // 先提交永久unknown；此后任一异常/进程崩溃都只能查证，不能推测POST未发生。
      await tx.paymentTxn.update({
        where: { id: row.id },
        data: {
          shippingReportState: "unknown",
          shippingReportAppid: intent.appid,
          shippingReportMchid: intent.mchid,
          shippingReportItemDesc: intent.description,
          shippingReportUploadTime: intent.uploadedAt,
          updatedAt: deps.clock.now(),
        },
      });
    }
    return { current, intent, upload };
  }
  async function settle(
    event: DeliveredEvent,
    original: Facts,
    intent: Intent,
    state: "confirmed" | "not_accepted",
  ) {
    active();
    return deps.tx.run(async (tx) => {
      active();
      const current = await facts(tx, event);
      const row = current.receipt;
      if (
        row.id !== original.receipt.id ||
        row.channelTxnNo !== original.receipt.channelTxnNo ||
        row.channelPayerRef !== original.receipt.channelPayerRef ||
        row.channelAmountFen !== original.receipt.channelAmountFen ||
        row.outTradeNo !== original.receipt.outTradeNo ||
        !sameIntent(row, intent)
      )
        throw invalid();
      if (row.shippingReportState === "confirmed") return;
      if (row.shippingReportState !== "unknown") throw unavailable();
      const observedAt = deps.clock.now();
      if (state === "confirmed" && observedAt.getTime() < intent.uploadedAt.getTime())
        throw unavailable();
      const changed = await tx.paymentTxn.updateMany({
        where: {
          id: row.id,
          shippingReportState: "unknown",
          shippingReportAppid: intent.appid,
          shippingReportMchid: intent.mchid,
          shippingReportItemDesc: intent.description,
          shippingReportUploadTime: intent.uploadedAt,
          channelTxnNo: original.receipt.channelTxnNo,
          channelPayerRef: original.receipt.channelPayerRef,
          channelAmountFen: original.receipt.channelAmountFen,
        },
        data: {
          shippingReportState: state,
          shippingReportConfirmedAt: state === "confirmed" ? observedAt : null,
          updatedAt: observedAt,
        },
      });
      if (changed.count !== 1) throw unavailable();
    });
  }
  return {
    async prepare(event: DeliveredEvent) {
      active();
      const paid = await deps.tx.run(async (tx) =>
        (await enabled(tx, deps.clock)) ? paidEvent(tx, event) : null,
      );
      if (!paid || paid.channel !== "wechat_jsapi") return;
      if (!deps.sessionMutex) throw unavailable();
      try {
        await deps.sessionMutex.run(`billing:shipping:${paid.paidPaymentTxnId}`, async (scope) => {
          const prepared = await deps.tx.run((tx) => claim(tx, event));
          if (!prepared) return;
          const { current, intent, upload } = prepared;
          await scope.assertHeld();
          active();
          if (upload) {
            const result = await deps.provider.uploadShippingInfo!({
              transactionId: current.receipt.channelTxnNo!,
              payerOpenid: current.receipt.channelPayerRef!,
              itemDescription: intent.description,
              uploadedAt: intent.uploadedAt,
              signal: scope.signal,
            });
            await scope.assertHeld();
            if (result.ok) await settle(event, current, intent, "confirmed");
            else {
              if (result.acceptance === "not_accepted")
                await settle(event, current, intent, "not_accepted");
              throw unavailable();
            }
          } else {
            const result = await deps.provider.queryShippingInfo!({
              transactionId: current.receipt.channelTxnNo!,
              signal: scope.signal,
            });
            await scope.assertHeld();
            if (!result.ok || !matches(result.value, current, intent)) throw unavailable();
            await settle(event, current, intent, "confirmed");
          }
        });
      } catch (error) {
        if (error instanceof SessionMutexError) throw new AppError("BUSY", { cause: error });
        throw error;
      }
    },
    /** 与投递done同TX，只核持久事实；绝不在消费事务中外呼。 */
    async consume(tx: Tx, event: DeliveredEvent) {
      active();
      if (!(await enabled(tx, deps.clock))) return;
      const current = await facts(tx, event);
      if (current.paid.channel !== "wechat_jsapi") return;
      if (current.receipt.shippingReportState === "confirmed") return;
      if (
        current.order.status === "refunded" &&
        (current.receipt.shippingReportState === null ||
          current.receipt.shippingReportState === "not_accepted")
      )
        return;
      throw unavailable();
    },
    close() {
      stopped = true;
    },
  };
}
