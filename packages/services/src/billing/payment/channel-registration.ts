import { createIdentityContext } from "../../kernel/index.js";
import type { DeliveredEvent, FiredTimer, RecurringRunContext, Tx } from "../../kernel/index.js";
import type { WechatChannel } from "./wechat-channel.js";
const bindings: WechatChannel[] = [];
export function bindPaymentChannel(channel: WechatChannel) {
  bindings.push(channel);
  return () => {
    const i = bindings.indexOf(channel);
    if (i >= 0) bindings.splice(i, 1);
  };
}
function bound() {
  const channel = bindings.at(-1);
  if (!channel) throw new TypeError("付款渠道运行时未绑定");
  return channel;
}
export async function applyPaymentFallback(tx: Tx, event: DeliveredEvent) {
  const id = event.payload.paymentTxnId;
  if (typeof id !== "string") throw new TypeError("收款事件缺少交易身份");
  await bound().apply(tx, {
    paymentTxnId: id,
    ctx: createIdentityContext({
      actor: { type: "system", job: "billing.apply_payment_fallback" },
    }),
  });
}
export async function expirePayment(tx: Tx, timer: FiredTimer) {
  if (timer.subjectType !== "billing_order" || !timer.subjectId) return "skipped" as const;
  const order = await tx.billingOrder.findUnique({ where: { id: timer.subjectId } });
  if (!order || timer.payload?.expiresAt !== order.expiresAt.toISOString())
    return "skipped" as const;
  return bound().expire(tx, order.id, timer.payload?.cancelReason === "user" ? "user" : "timeout");
}
export async function scanUnapplied(ctx: RecurringRunContext) {
  if (!ctx.runTx || !ctx.signal) throw new TypeError("收款扫描要求受租约保护的任务运输");
  const check = () => {
    if (ctx.signal!.aborted) throw new Error("收款扫描已取消");
  };
  check();
  const ids = await ctx.runTx((tx) =>
    tx.$queryRawUnsafe<{ id: string }[]>(
      "SELECT p.id FROM payment_txn p WHERE p.status='succeeded' AND p.applied_at IS NULL AND p.refunded_fen < p.channel_amount_fen AND NOT EXISTS (SELECT 1 FROM payment_exception e WHERE e.payment_txn_id=p.id AND e.status IN ('open','resolving')) ORDER BY p.channel_success_at,p.id LIMIT 100",
    ),
  );
  let processed = 0;
  for (const { id } of ids) {
    check();
    await ctx.runTx((tx) =>
      bound().apply(tx, {
        paymentTxnId: id,
        ctx: createIdentityContext({ actor: { type: "system", job: "tx.unapplied_scan" } }),
      }),
    );
    processed++;
  }
  return { processed };
}
