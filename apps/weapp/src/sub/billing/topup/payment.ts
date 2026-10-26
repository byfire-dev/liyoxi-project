import type { PaymentOutcome, PaymentParams } from "@/lib/platform";
import type { PurchaseApi } from "../plan-pick/api";
import type { Payment } from "../plan-pick/model";
import { purchaseVisible } from "../wallet/model";

export interface PaymentResult {
  order: Payment;
  notice: string | null;
}
/** 付款单创建以后才可进入；每次调用都以当前身份、当前策略和后端 actions 为准。 */
export function createPaymentIntent(deps: {
  api: Pick<PurchaseApi, "policy" | "detail" | "prepay" | "sync" | "cancel">;
  current(): boolean;
  key(): string;
  now(): number;
  pay(params: PaymentParams, onSuccess: () => void): Promise<PaymentOutcome>;
  onSuccess(): void;
}) {
  let busy = false,
    generation = 0;
  const lastSync = new Map<string, number>();
  async function run(
    kind: "pay" | "sync" | "cancel",
    id: string,
  ): Promise<PaymentResult | undefined> {
    // 同步加锁，React 尚未提交 busy 状态时也不能重入。
    if (busy || !deps.current()) return;
    busy = true;
    const own = generation;
    const current = () => own === generation && deps.current();
    try {
      let order = await deps.api.detail(id);
      if (!current()) return;
      const action = kind === "pay" ? "wechat-prepay" : kind;
      if (!order.actions.includes(action)) return { order, notice: "付款单状态已更新，请核对结果" };
      if (kind === "cancel") {
        const result = await deps.api.cancel(id, deps.key());
        if (!current()) return;
        return {
          order: result.paymentOrder,
          notice:
            result.outcome === "paid"
              ? "已确认付款，请查看处理结果"
              : result.outcome === "cancelling"
                ? "正在确认取消结果，请稍后查询"
                : "付款单已取消",
        };
      }
      if (kind === "sync") {
        const previous = lastSync.get(id);
        if (previous !== undefined && deps.now() - previous < 3000)
          return { order, notice: "请间隔 3 秒再查询付款结果" };
        lastSync.set(id, deps.now());
        order = await deps.api.sync(id);
        return current() ? { order, notice: null } : undefined;
      }
      const policy = await deps.api.policy();
      if (!current()) return;
      if (
        order.channel !== "wechat_jsapi" ||
        !purchaseVisible(policy) ||
        !policy.channels.some((channel) => channel.code === "wechat_jsapi" && channel.isEnabled)
      )
        return { order, notice: "当前未开放微信支付，请联系服务经理" };
      let prepared = await deps.api.prepay(id, deps.key());
      if (!current()) return;
      if (prepared.payParams === null) {
        // C50：重放脱敏不代表已付。先读既有单，仍待付才发起一次新意图；不循环重试。
        order = await deps.api.detail(id);
        if (!current()) return;
        if (order.status !== "pending_payment" || !order.actions.includes("wechat-prepay"))
          return { order, notice: null };
        prepared = await deps.api.prepay(id, deps.key());
        if (!current()) return;
      }
      if (!prepared.payParams || prepared.paymentOrder.status !== "pending_payment")
        return { order: prepared.paymentOrder, notice: "请重新查询付款结果后继续支付" };
      const outcome = await deps.pay(prepared.payParams, () => {
        if (current()) deps.onSuccess();
      });
      if (!current()) return;
      // 平台 success/cancel/fail 均不在本地改状态，始终回查真实付款单。
      order = await deps.api.detail(id);
      if (!current()) return;
      return {
        order,
        notice:
          outcome === "cancelled"
            ? "已退出微信支付，付款单仍可继续处理"
            : outcome === "failed"
              ? "微信支付未完成，请查询结果后再继续"
              : outcome === "unsupported"
                ? "当前环境不支持微信支付，请在微信小程序中操作"
                : "微信支付回调已返回，到账与履约以付款单结果为准",
      };
    } finally {
      if (own === generation) busy = false;
    }
  }
  return {
    invalidate() {
      generation++;
      busy = false;
    },
    get pending() {
      return busy;
    },
    pay: (id: string) => run("pay", id),
    sync: (id: string) => run("sync", id),
    cancel: (id: string) => run("cancel", id),
  };
}
