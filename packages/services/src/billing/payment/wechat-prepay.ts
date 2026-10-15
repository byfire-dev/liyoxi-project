// m07§3.9：先持久意图、事务外渠道IO、复核后保存prepay；签名只出本次响应。
import { randomBytes } from "node:crypto";
import type { BillingOrder, PaymentTxn } from "@liyoxi/db";
import type { PaymentOrderWechatPrepayResult } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import {
  AppError,
  createIdentityContext,
  createThreePhaseRunner,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import type { IdempotencyContext, Tx } from "../../kernel/index.js";
import type { ProviderResult, WechatPayTransaction } from "../../providers/types.js";
import { getEntitlements } from "../read/index.js";
import { getPurchasePolicy } from "../policy/index.js";
import type { PurchaseClient } from "../policy/index.js";
import type { BillingPurchaseDeps, PurchaseActor, WechatPayerSession } from "./purchase-context.js";
import { merchantOrderView } from "./purchase-read.js";
import { recordChannelSuccess, wechatOrderAttach } from "./channel-success.js";

type Attempt = { order: BillingOrder; receipt: PaymentTxn; payer: string };
type Outcome = { receipt: PaymentTxn; prepayId: string | null; reused?: boolean };
function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
  return result.value;
}

export type WechatPrepayDeps = Pick<
  BillingPurchaseDeps,
  "tx" | "clock" | "tenant" | "config" | "events" | "payment" | "wechatPay" | "keyring"
>;
export function createWechatPrepay(deps: WechatPrepayDeps) {
  const phases = createThreePhaseRunner(deps);
  const configured = () => {
    if (!deps.wechatPay?.provider.configured) throw new AppError("PROVIDER_UNAVAILABLE");
    return deps.wechatPay;
  };
  async function visible(tx: Tx, actor: PurchaseActor, id: string, lock: boolean) {
    if (
      actor.ctx.actor.type !== "merchant" ||
      !actor.ctx.actor.id ||
      actor.ctx.actor.role !== "owner" ||
      actor.membership.role !== "owner" ||
      actor.ctx.entityId !== actor.membership.entityId
    )
      throw new AppError("ROLE_FORBIDDEN");
    if (lock) await lockRows(tx, "entity", [actor.membership.entityId]);
    const membership = await deps.tenant.resolveMembership(tx, {
      merchantUserId: actor.ctx.actor.id,
      storeId: actor.membership.storeId,
    });
    if (membership?.role !== "owner" || membership.entityId !== actor.membership.entityId)
      throw new AppError("NOT_FOUND");
    if (lock) await lockRows(tx, "billing_order", [id]);
    const order = await tx.billingOrder.findFirst({ where: { id, entityId: membership.entityId } });
    if (!order) throw new AppError("NOT_FOUND");
    return order;
  }
  async function payer(tx: Tx, actor: PurchaseActor, session: WechatPayerSession | undefined) {
    if (!session || session.merchantUserId !== actor.ctx.actor.id)
      throw new AppError("SESSION_INVALID");
    return configured().currentOpenid(tx, session);
  }
  async function guards(
    tx: Tx,
    actor: PurchaseActor,
    client: PurchaseClient,
    order: BillingOrder,
    openid: string,
  ) {
    if (order.status !== "pending_payment" || order.channel !== "wechat_jsapi")
      throw new AppError("STATE_NOT_ALLOWED");
    const now = deps.clock.now();
    if (now.getTime() >= order.expiresAt.getTime() - 60_000)
      throw new AppError("PAYMENT_ORDER_EXPIRED");
    if (!Number.isSafeInteger(order.amountFen) || order.amountFen <= 0)
      throw new AppError("STATE_NOT_ALLOWED");
    const entity = await tx.entity.findUniqueOrThrow({
      where: { id: order.entityId },
      select: { verificationStatus: true },
    });
    if (!["verified", "pending"].includes(entity.verificationStatus))
      throw new AppError("PURCHASE_QUALIFICATION_REQUIRED", {
        details: { verificationStatus: entity.verificationStatus },
      });
    if ((await getEntitlements(tx, order.entityId, now)).refundPending)
      throw new AppError("PLAN_REFUND_IN_PROGRESS");
    const start = new Date(`${calendarDate(now)}T00:00:00+08:00`),
      end = new Date(start.getTime() + 86_400_000);
    const paid = await tx.paymentTxn.aggregate({
      where: {
        channel: "wechat_jsapi",
        status: "succeeded",
        channelPayerRef: openid,
        OR: [{ billingOrderId: null }, { billingOrderId: { not: order.id } }],
        channelSuccessAt: { gte: start, lt: end },
      },
      _sum: { channelAmountFen: true },
    });
    const policy = await getPurchasePolicy(
      tx,
      deps.config,
      actor.membership.entityId,
      now,
      client,
      order.type,
      order.amountFen,
      configured().provider.configured,
      paid._sum.channelAmountFen ?? 0,
    );
    if (!policy.channels.some((c) => c.code === "wechat_jsapi" && c.isEnabled))
      throw new AppError("CHANNEL_NOT_ALLOWED", { details: { channels: policy.channels } });
  }
  async function current(tx: Tx, order: BillingOrder) {
    const latest = await tx.paymentTxn.findFirst({
      where: { billingOrderId: order.id },
      orderBy: { attemptNo: "desc" },
    });
    if (latest) await lockRows(tx, "payment_txn", [latest.id]);
    return latest ? tx.paymentTxn.findUniqueOrThrow({ where: { id: latest.id } }) : null;
  }
  async function createAttempt(
    tx: Tx,
    order: BillingOrder,
    openid: string,
    previous: PaymentTxn | null,
  ) {
    const attach = wechatOrderAttach(order);
    if (!attach || Buffer.byteLength(attach) > 128) throw new AppError("STATE_NOT_ALLOWED");
    const attemptNo = (previous?.attemptNo ?? 0) + 1;
    if (attemptNo > 99) throw new AppError("STATE_NOT_ALLOWED");
    return tx.paymentTxn.create({
      data: {
        id: uuidv7(),
        entityId: order.entityId,
        billingOrderId: order.id,
        channel: "wechat_jsapi",
        attemptNo,
        outTradeNo: `${order.orderNo}-${String(attemptNo).padStart(2, "0")}-${randomBytes(3).toString("hex").toUpperCase()}`,
        amountFen: order.amountFen,
        payerOpenid: openid,
        attach,
        status: "created",
        createdAt: deps.clock.now(),
        updatedAt: deps.clock.now(),
      },
    });
  }
  const factContext = (actor: PurchaseActor) =>
    createIdentityContext({
      ...actor.ctx,
      actor: { type: "system", job: "billing.wechat_prepay" },
    });
  async function paid(
    actor: PurchaseActor,
    receipt: PaymentTxn,
    fact: WechatPayTransaction,
  ): Promise<Outcome> {
    const pay = configured();
    // 资金事实独立提交；ACCOUNT_BUSY/连接失败只能回滚入账，不能丢掉已收款事实。
    await deps.tx.run((tx) =>
      recordChannelSuccess(
        tx,
        { clock: deps.clock, events: deps.events, appid: pay.appid, mchid: pay.mchid },
        factContext(actor),
        { paymentTxnId: receipt.id, transaction: fact },
      ),
    );
    await deps.tx.run((tx) =>
      deps.payment.applyPayment(tx, { paymentTxnId: receipt.id, ctx: factContext(actor) }),
    );
    return { receipt, prepayId: null };
  }
  async function query(receipt: PaymentTxn): Promise<WechatPayTransaction> {
    const pay = configured();
    const fact = value(await pay.provider.queryByOutTradeNo({ outTradeNo: receipt.outTradeNo }));
    if (
      fact.outTradeNo !== receipt.outTradeNo ||
      fact.appid !== pay.appid ||
      fact.mchid !== pay.mchid
    )
      throw new AppError("PROVIDER_UNAVAILABLE");
    return fact;
  }
  return async (
    actor: PurchaseActor,
    client: PurchaseClient,
    id: string,
    options: { idem?: IdempotencyContext; session?: WechatPayerSession } = {},
  ): Promise<PaymentOrderWechatPrepayResult> => {
    if (options.idem?.mode !== "required") throw new AppError("INTERNAL");
    // 重放也校当前归属与会话；已付/过期不妨碍合法同键重放。
    await deps.tx.run(async (tx) => {
      await visible(tx, actor, id, false);
      await payer(tx, actor, options.session);
    });
    let invoked: PaymentTxn | undefined;
    let signId: string | null = null;
    try {
      const result = await phases.run<PaymentOrderWechatPrepayResult, Outcome, Attempt>(
        {
          claim: async (tx) => {
            const order = await visible(tx, actor, id, true),
              openid = await payer(tx, actor, options.session);
            await guards(tx, actor, client, order, openid);
            const previous = await current(tx, order);
            if (previous?.status === "succeeded")
              return { order, receipt: previous, payer: openid };
            if (previous?.status === "closed" && previous.payerOpenid === openid)
              throw new AppError("PAYMENT_ORDER_CLOSED");
            const receipt =
              previous && previous.status !== "closed"
                ? previous
                : await createAttempt(tx, order, openid, previous);
            if (
              receipt.amountFen !== order.amountFen ||
              receipt.attach !== wechatOrderAttach(order)
            )
              throw new AppError("STATE_NOT_ALLOWED");
            return { order, receipt, payer: openid };
          },
          external: async (attempt) => {
            const provider = configured().provider;
            let receipt = attempt.receipt;
            if (receipt.status === "succeeded") {
              await deps.tx.run((tx) =>
                deps.payment.applyPayment(tx, {
                  paymentTxnId: receipt.id,
                  ctx: factContext(actor),
                }),
              );
              return { receipt, prepayId: null };
            }
            if (receipt.payerOpenid !== attempt.payer) {
              let fact = await query(receipt);
              if (fact.tradeState === "SUCCESS") return paid(actor, receipt, fact);
              if (!["NOTPAY", "CLOSED", "REVOKED", "PAYERROR"].includes(fact.tradeState))
                throw new AppError("PROVIDER_UNAVAILABLE");
              const closed = value(await provider.closeOrder({ outTradeNo: receipt.outTradeNo }));
              if (closed.outcome === "paid") {
                fact = await query(receipt);
                return paid(actor, receipt, fact);
              }
              receipt = await deps.tx.run(async (tx) => {
                const order = await visible(tx, actor, id, true),
                  openid = await payer(tx, actor, options.session);
                await guards(tx, actor, client, order, openid);
                const latest = await current(tx, order);
                if (
                  openid !== attempt.payer ||
                  latest?.id !== receipt.id ||
                  latest.status === "succeeded"
                )
                  throw new AppError("PAYMENT_ORDER_CLOSED");
                await tx.paymentTxn.update({
                  where: { id: latest.id },
                  data: { status: "closed", updatedAt: deps.clock.now() },
                });
                return createAttempt(tx, order, openid, latest);
              });
            }
            if (
              receipt.status === "prepaid" &&
              receipt.prepayId &&
              receipt.prepayExpiresAt &&
              receipt.prepayExpiresAt.getTime() - deps.clock.now().getTime() > 300_000
            )
              return { receipt, prepayId: receipt.prepayId, reused: true };
            invoked = receipt;
            const out = value(
              await provider.createJsapiOrder({
                outTradeNo: receipt.outTradeNo,
                description: "套餐付款",
                amountFen: receipt.amountFen,
                payerOpenid: receipt.payerOpenid!,
                attach: receipt.attach!,
                expireAt: attempt.order.expiresAt,
              }),
            );
            if (!out.prepayId) throw new AppError("PROVIDER_UNAVAILABLE");
            return { receipt, prepayId: out.prepayId };
          },
          settle: async (tx, outcome) => {
            const order = await visible(tx, actor, id, true);
            const openid = await payer(tx, actor, options.session);
            await lockRows(tx, "payment_txn", [outcome.receipt.id]);
            const receipt = await tx.paymentTxn.findUniqueOrThrow({
              where: { id: outcome.receipt.id },
            });
            if (outcome.prepayId !== null) {
              if (
                order.status !== "pending_payment" ||
                !["created", "prepaid"].includes(receipt.status) ||
                receipt.payerOpenid !== openid ||
                receipt.amountFen !== order.amountFen
              )
                throw new AppError("PAYMENT_ORDER_CLOSED");
              await guards(tx, actor, client, order, openid);
              if (!outcome.reused)
                await tx.paymentTxn.update({
                  where: { id: receipt.id },
                  data: {
                    status: "prepaid",
                    prepayId: outcome.prepayId,
                    prepayExpiresAt: new Date(deps.clock.now().getTime() + 7_200_000),
                    updatedAt: deps.clock.now(),
                  },
                });
              signId = outcome.prepayId;
            }
            return {
              payParams: null,
              replayed: false,
              paymentOrder: await merchantOrderView(tx, deps, order, client),
            };
          },
        },
        options,
      );
      if (options.idem.replayed) return { ...result, payParams: null, replayed: true };
      if (!signId) return result;
      const signed = value(await configured().provider.signMiniProgramPay({ prepayId: signId }));
      if (
        signed.appId !== configured().appid ||
        signed.signType !== "RSA" ||
        signed.package !== `prepay_id=${signId}` ||
        !signed.paySign ||
        !signed.nonceStr ||
        !/^\d+$/.test(signed.timeStamp)
      )
        throw new AppError("PROVIDER_UNAVAILABLE");
      return {
        ...result,
        payParams: {
          timeStamp: signed.timeStamp,
          nonceStr: signed.nonceStr,
          package: signed.package,
          signType: signed.signType,
          paySign: signed.paySign,
        },
      };
    } catch (error) {
      // B守卫拒绝时，A已提交；立即尝试关闭已外呼尝试，不把渠道未知说成关单成功。
      if (invoked && error instanceof AppError && error.error === "PAYMENT_ORDER_CLOSED") {
        const closed = value(
          await configured().provider.closeOrder({ outTradeNo: invoked.outTradeNo }),
        );
        if (closed.outcome === "paid") {
          const fact = await query(invoked);
          await paid(actor, invoked, fact);
        } else
          await deps.tx.run(async (tx) => {
            await lockRows(tx, "billing_order", [id]);
            await lockRows(tx, "payment_txn", [invoked!.id]);
            await tx.paymentTxn.updateMany({
              where: { id: invoked!.id, status: { in: ["created", "prepaid"] } },
              data: { status: "closed", updatedAt: deps.clock.now() },
            });
          });
      }
      throw error;
    }
  };
}
