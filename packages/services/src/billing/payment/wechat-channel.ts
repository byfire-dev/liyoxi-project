// 查询/关单不占业务事务；成功事实独立提交，再复用唯一入账事务。
import type { BillingOrder, PaymentTxn } from "@liyoxi/db";
import {
  AppError,
  createIdentityContext,
  createThreePhaseRunner,
  lockRows,
} from "../../kernel/index.js";
import type { IdempotencyContext, IdentityContext, Tx } from "../../kernel/index.js";
import type { TimerRef } from "../../timers/index.js";
import type { WechatPayTransaction } from "../../providers/types.js";
import type { BillingPurchaseDeps, PurchaseActor } from "./purchase-context.js";
import type { PurchaseClient } from "../policy/index.js";
import { merchantOrderView } from "./purchase-read.js";
import { recordChannelSuccess } from "./channel-success.js";
import { openPaymentException } from "./exception.js";

export type WechatChannelDeps = Pick<
  BillingPurchaseDeps,
  | "tx"
  | "clock"
  | "tenant"
  | "config"
  | "keyring"
  | "flow"
  | "timers"
  | "events"
  | "bizNo"
  | "payment"
  | "wechatPay"
>;
type Observed = {
  receipt: PaymentTxn;
  fact?: WechatPayTransaction;
  closed: boolean;
  mismatch?: boolean;
};
const system = (order?: BillingOrder) =>
  createIdentityContext({
    actor: { type: "system", job: "billing.wechat_channel" },
    ...(order ? { entityId: order.entityId, storeId: order.storeId } : {}),
  });
export function createWechatChannel(deps: WechatChannelDeps) {
  const phases = createThreePhaseRunner(deps);
  async function visible(tx: Tx, actor: PurchaseActor, id: string, locked = false) {
    if (
      actor.ctx.actor.type !== "merchant" ||
      actor.ctx.actor.role !== "owner" ||
      !actor.ctx.actor.id ||
      actor.membership.role !== "owner" ||
      actor.ctx.entityId !== actor.membership.entityId
    )
      throw new AppError("ROLE_FORBIDDEN");
    if (locked) await lockRows(tx, "entity", [actor.membership.entityId], "share");
    const current = await deps.tenant.resolveMembership(tx, {
      merchantUserId: actor.ctx.actor.id,
      storeId: actor.membership.storeId,
    });
    if (current?.role !== "owner" || current.entityId !== actor.membership.entityId)
      throw new AppError("NOT_FOUND");
    if (locked) await lockRows(tx, "billing_order", [id]);
    const order = await tx.billingOrder.findFirst({ where: { id, entityId: current.entityId } });
    if (!order) throw new AppError("NOT_FOUND");
    return order;
  }
  async function attempts(tx: Tx, id: string) {
    return tx.paymentTxn.findMany({
      where: { billingOrderId: id, channel: "wechat_jsapi" },
      orderBy: { id: "asc" },
    });
  }
  async function observe(receipts: PaymentTxn[], close: boolean): Promise<Observed[]> {
    const pay = deps.wechatPay;
    const result: Observed[] = [];
    for (const receipt of receipts) {
      if (receipt.status === "closed") {
        result.push({ receipt, closed: true });
        continue;
      }
      if (!pay?.provider.configured) {
        result.push({ receipt, closed: false });
        continue;
      }
      let queried = await pay.provider.queryByOutTradeNo({ outTradeNo: receipt.outTradeNo });
      const trusted = (fact: WechatPayTransaction) =>
        fact.outTradeNo === receipt.outTradeNo &&
        fact.appid === pay.appid &&
        fact.mchid === pay.mchid;
      if (!queried.ok || !trusted(queried.value)) {
        result.push({ receipt, closed: false });
        continue;
      }
      if (receipt.status === "succeeded" && queried.value.tradeState !== "SUCCESS") {
        result.push({ receipt, fact: queried.value, closed: false, mismatch: true });
        continue;
      }
      if (queried.value.tradeState === "SUCCESS") {
        result.push({ receipt, fact: queried.value, closed: false });
        continue;
      }
      if (queried.value.tradeState === "CLOSED") {
        result.push({ receipt, closed: true });
        continue;
      }
      if (
        !close ||
        !["NOTPAY", "USERPAYING", "REVOKED", "PAYERROR"].includes(queried.value.tradeState)
      ) {
        result.push({ receipt, closed: false });
        continue;
      }
      const closed = await pay.provider.closeOrder({ outTradeNo: receipt.outTradeNo });
      if (!closed.ok) {
        result.push({ receipt, closed: false });
        continue;
      }
      if (closed.value.outcome === "closed") result.push({ receipt, closed: true });
      else {
        queried = await pay.provider.queryByOutTradeNo({ outTradeNo: receipt.outTradeNo });
        result.push({
          receipt,
          ...(queried.ok && trusted(queried.value) && queried.value.tradeState === "SUCCESS"
            ? { fact: queried.value }
            : {}),
          closed: false,
        });
      }
    }
    return result;
  }
  async function record(
    tx: Tx,
    receipt: PaymentTxn,
    fact: WechatPayTransaction,
    ctx: IdentityContext,
    detectedBy: "query" | "callback",
  ) {
    if (!deps.wechatPay) throw new AppError("PROVIDER_UNAVAILABLE");
    return recordChannelSuccess(
      tx,
      {
        clock: deps.clock,
        events: deps.events,
        appid: deps.wechatPay.appid,
        mchid: deps.wechatPay.mchid,
        exceptions: deps,
        detectedBy,
      },
      ctx,
      { paymentTxnId: receipt.id, transaction: fact },
    );
  }
  async function persist(observed: Observed[], order: BillingOrder) {
    for (const item of observed) {
      if (item.mismatch) {
        await deps.tx.run(async (tx) => {
          await lockRows(tx, "billing_order", [order.id]);
          await lockRows(tx, "payment_txn", [item.receipt.id]);
          await openPaymentException(tx, deps, system(order), {
            kind: "status_mismatch",
            order: await tx.billingOrder.findUniqueOrThrow({ where: { id: order.id } }),
            receipt: await tx.paymentTxn.findUniqueOrThrow({ where: { id: item.receipt.id } }),
            detectedBy: "query",
            channelFact: item.fact,
          });
        });
      } else if (item.fact) {
        const saved = await deps.tx.run((tx) =>
          record(tx, item.receipt, item.fact!, system(order), "query"),
        );
        if (saved.conflict) continue;
        const applied = await deps.tx.run((tx) =>
          deps.payment.applyPayment(tx, { paymentTxnId: item.receipt.id, ctx: system(order) }),
        );
        if (
          !saved.replayed &&
          applied.result.status === "applied" &&
          applied.result.fulfillment.status === "done"
        )
          await deps.tx.run(async (tx) => {
            await lockRows(tx, "billing_order", [order.id]);
            await lockRows(tx, "payment_txn", [item.receipt.id]);
            const current = await tx.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
            const receipt = await tx.paymentTxn.findUniqueOrThrow({
              where: { id: item.receipt.id },
            });
            if (receipt.appliedAt && current.fulfillmentStatus === "done")
              await openPaymentException(tx, deps, system(current), {
                kind: "bill_only",
                order: current,
                receipt,
                detectedBy: "query",
                healed: true,
              });
          });
      } else if (item.closed)
        await deps.tx.run(async (tx) => {
          await lockRows(tx, "billing_order", [order.id]);
          await lockRows(tx, "payment_txn", [item.receipt.id]);
          await tx.paymentTxn.updateMany({
            where: {
              id: item.receipt.id,
              billingOrderId: order.id,
              status: { in: ["created", "prepaid"] },
            },
            data: { status: "closed", updatedAt: deps.clock.now() },
          });
        });
      else if (item.receipt.status === "succeeded")
        await deps.tx.run((tx) =>
          deps.payment.applyPayment(tx, { paymentTxnId: item.receipt.id, ctx: system(order) }),
        );
    }
  }
  async function cancelLocked(
    tx: Tx,
    order: BillingOrder,
    ctx: IdentityContext,
    reason: "user" | "timeout",
  ) {
    const current = await tx.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (
      ["paid", "refunded"].includes(current.status) ||
      (await tx.paymentTxn.count({ where: { billingOrderId: order.id, status: "succeeded" } }))
    )
      return "paid" as const;
    if (current.status === "cancelled") return "cancelled" as const;
    if (current.status === "pending_confirmation") throw new AppError("TRANSFER_PROOF_PENDING");
    if (current.status !== "pending_payment") throw new AppError("STATE_NOT_ALLOWED");
    if (
      current.channel === "wechat_jsapi" &&
      (await tx.paymentTxn.count({
        where: { billingOrderId: current.id, status: { not: "closed" } },
      }))
    ) {
      await deps.timers.arm(tx, {
        kind: "po.expire",
        subject: { type: "billing_order", id: current.id },
        key: `po.expire:billing_order:${current.id}`,
        fireAt: deps.clock.now(),
        payload: { expiresAt: current.expiresAt.toISOString(), cancelReason: reason },
        entityId: current.entityId,
        ...(current.storeId ? { storeId: current.storeId } : {}),
      });
      return "cancelling" as const;
    }
    if (
      current.channel === "bank_transfer" &&
      (await tx.transferProof.count({
        where: { billingOrderId: current.id, reviewStatus: "pending" },
      }))
    )
      throw new AppError("TRANSFER_PROOF_PENDING");
    await deps.flow.transition(tx, ctx, {
      machine: "billing_order",
      stateField: "status",
      id: current.id,
      event: "billing_order.cancel",
      ref: current.channel === "wechat_jsapi" ? "08:166" : "08:175",
      reasonCode: reason,
      set: { cancelled_at: deps.clock.now(), cancel_reason: reason, transfer_state: null },
      entityId: current.entityId,
      storeId: current.storeId,
      audit: {
        stream: "activity",
        category: "payment",
        action: "billing.order.cancel",
        summary: reason === "user" ? "取消付款单" : "微信付款单到期取消",
        target: { type: "billing_order", id: current.id },
      },
      emit: {
        type: "billing_order.cancelled",
        payload: {
          v: 1,
          billingOrderId: current.id,
          entityId: current.entityId,
          cancelReason: reason,
        },
        dedupeKey: `billing_order.cancelled:${current.id}`,
      },
    });
    await deps.timers.cancel(tx, {
      subject: { type: "billing_order", id: current.id },
      kinds: [current.channel === "wechat_jsapi" ? "po.expire" : "po.transfer_ttl"],
    });
    return "cancelled" as const;
  }
  return {
    async sync(actor: PurchaseActor, client: PurchaseClient, id: string) {
      const order = await deps.tx.run((tx) => visible(tx, actor, id));
      if (order.channel === "wechat_jsapi") {
        const receipts = await deps.tx.run((tx) => attempts(tx, id));
        await persist(await observe(receipts, false), order);
      }
      return deps.tx.run(async (tx) =>
        merchantOrderView(tx, deps, await visible(tx, actor, id), client),
      );
    },
    async cancel(
      actor: PurchaseActor,
      client: PurchaseClient,
      id: string,
      options: { idem?: IdempotencyContext } = {},
    ) {
      if (options.idem?.mode !== "required") throw new AppError("INTERNAL");
      await deps.tx.run((tx) => visible(tx, actor, id));
      return phases.run(
        {
          claim: async (tx) => {
            const order = await visible(tx, actor, id, true);
            if (order.status === "pending_confirmation")
              throw new AppError("TRANSFER_PROOF_PENDING");
            if (!["pending_payment", "paid"].includes(order.status))
              throw new AppError("STATE_NOT_ALLOWED");
            return { order, receipts: await attempts(tx, id) };
          },
          external: async (intent) => {
            if (intent.order.channel === "wechat_jsapi")
              await persist(await observe(intent.receipts, true), intent.order);
            return intent.order;
          },
          settle: async (tx, _out) => {
            const order = await visible(tx, actor, id, true);
            const outcome = await cancelLocked(tx, order, actor.ctx, "user");
            return {
              outcome,
              paymentOrder: await merchantOrderView(
                tx,
                deps,
                await tx.billingOrder.findUniqueOrThrow({ where: { id } }),
                client,
              ),
            };
          },
        },
        options,
      );
    },
    record,
    async inlineWebhook(eventId: string) {
      try {
        const receipt = await deps.tx.run(async (tx) => {
          const row = await tx.webhookEvent.findUnique({
            where: { provider_eventId: { provider: "wechatpay", eventId } },
          });
          if (row?.processState !== "processed" || row.eventType !== "TRANSACTION.SUCCESS")
            return null;
          const payload = row.payload;
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
          const summary = payload.summary;
          if (
            !summary ||
            typeof summary !== "object" ||
            Array.isArray(summary) ||
            typeof summary.outTradeNo !== "string"
          )
            return null;
          return tx.paymentTxn.findUnique({ where: { outTradeNo: summary.outTradeNo } });
        });
        if (!receipt || receipt.status !== "succeeded" || receipt.appliedAt) return;
        // 应答只依赖已提交T1/T1′；此短事务失败由原出站订阅与扫描继续补偿。
        await deps.tx.run(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1500ms'");
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3s'");
          await deps.payment.applyPayment(tx, { paymentTxnId: receipt.id });
        });
      } catch {
        /* 已持久收款事实；不把入账失败转换成渠道拒收。 */
      }
    },
    async prepareExpire(ref: TimerRef) {
      if (ref.kind !== "po.expire") return;
      const due = await deps.tx.run(async (tx) => {
        const timer = await tx.timer.findUnique({ where: { id: ref.timerId } });
        if (
          timer?.kind !== ref.kind ||
          timer.status !== "dispatched" ||
          timer.dispatchNo !== ref.dispatchNo ||
          timer.fireAt > deps.clock.now() ||
          timer.subjectType !== "billing_order" ||
          !timer.subjectId
        )
          return null;
        const order = await tx.billingOrder.findUnique({ where: { id: timer.subjectId } });
        if (
          !order ||
          order.channel !== "wechat_jsapi" ||
          order.status !== "pending_payment" ||
          typeof timer.payload !== "object" ||
          timer.payload === null ||
          Array.isArray(timer.payload) ||
          timer.payload.expiresAt !== order.expiresAt.toISOString()
        )
          return null;
        return { order, receipts: await attempts(tx, order.id) };
      });
      if (due) await persist(await observe(due.receipts, true), due.order);
    },
    async expire(tx: Tx, id: string, reason: "user" | "timeout" = "timeout") {
      await lockRows(tx, "billing_order", [id]);
      const order = await tx.billingOrder.findUnique({ where: { id } });
      if (!order || order.channel !== "wechat_jsapi" || order.status !== "pending_payment")
        return "skipped" as const;
      if (reason === "timeout" && order.expiresAt > deps.clock.now()) return "skipped" as const;
      const result = await cancelLocked(tx, order, system(order), reason);
      if (result === "cancelling") throw new AppError("PROVIDER_UNAVAILABLE");
      return "fired" as const;
    },
    apply: deps.payment.applyPayment,
  };
}
export type WechatChannel = ReturnType<typeof createWechatChannel>;
