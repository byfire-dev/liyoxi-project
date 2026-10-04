// 假微信支付：内存里的订单与退款，加一个回调编排器（D7 第 10.1 节；W0-19 任务书 第 7 节第 7 条）。
//
// 能编排的五样：
//   延迟      pay(单号, { delayMs })：通知晚到。拨动时钟后 deliverDue() 才投
//   重复      pay(单号, { copies })：同一条通知（编号相同）投几次
//   乱序      queue 就是待投的队列，按数组顺序投；reorder() 改它的顺序，缺省倒过来
//   失败      接口调用失败用 failNext()；回调处理器应答失败（返回 false 或抛错）时，
//             这条通知隔 retryDelayMs 重投，最多投 maxAttempts 次
//   查单结果  setQueryResult(单号, 结果)：之后查这个单号都返回它
// 预下单幂等于商户单号、退款幂等于退款单号：同号、同样的入参重复调用返回同一个结果，只生效一次。
// 通知的请求头与请求体是替身自己的格式（签名是摘要，不是真实的验签）；真实结构的通知由 X-04 扩。

import { createHash } from "node:crypto";

import { failed, ok } from "../../providers/types.js";
import type {
  ProviderFailure,
  ProviderMethodName,
  ProviderResult,
  WechatPayNotification,
  WechatPayProvider,
  WechatPayRefund,
  WechatPayRefundStatus,
  WechatPayTradeState,
  WechatPayTransaction,
} from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<WechatPayProvider>;

export interface FakeWechatPayOrder {
  outTradeNo: string;
  prepayId: string;
  description: string;
  amountFen: number;
  payerOpenid: string;
  attach?: string;
  expireAt?: Date;
  tradeState: WechatPayTradeState;
  transactionId?: string;
  successAt?: Date;
}

export interface NotificationPlan {
  /** 晚多少毫秒投（按替身的时钟）。缺省 0：下一次 deliverDue() 就投 */
  delayMs?: number;
  /** 同一条通知一共投几次。缺省 1 */
  copies?: number;
}

export interface QueuedNotification {
  notification: WechatPayNotification;
  dueAt: Date;
  /** 第几次投这条通知，从 1 起 */
  attempt: number;
}

/** 交给回调处理器的一次投递：处理器照真实回调那样，先拿 headers 与 rawBody 去验签解密 */
export interface FakeWechatPayDelivery {
  headers: Record<string, string>;
  rawBody: string;
  attempt: number;
}

/** 回调处理器。返回 false 或抛错表示应答失败，替身会重投；其余都算应答成功 */
export type FakeNotificationHandler = (
  delivery: FakeWechatPayDelivery,
) => boolean | void | Promise<boolean | void>;

export interface FakeDeliveryRecord {
  notification: WechatPayNotification;
  attempt: number;
  at: Date;
  acknowledged: boolean;
}

export interface FakeWechatPay extends WechatPayProvider, FakeControl<Method> {
  readonly orders: Map<string, FakeWechatPayOrder>;
  readonly refunds: Map<string, WechatPayRefund>;
  /** 待投的通知，deliverDue() 按数组顺序投到点的。可以直接改它来造乱序 */
  readonly queue: QueuedNotification[];
  /** 投出去的记录，按投递的先后 */
  readonly deliveries: FakeDeliveryRecord[];
  /** 处理器应答失败后隔多久重投。缺省 15 秒 */
  retryDelayMs: number;
  /** 一条通知最多投几次（含第一次）。缺省 5 */
  maxAttempts: number;
  /** 登记回调处理器。没登记时 deliverDue() 只记投递记录，算应答成功 */
  onNotification(handler: FakeNotificationHandler): void;
  /** 模拟用户付款成功：订单置为 SUCCESS，并按 plan 排一条支付成功通知。返回这条通知 */
  pay(outTradeNo: string, plan?: NotificationPlan): WechatPayNotification;
  /** 模拟退款有了结果（缺省 SUCCESS），并按 plan 排一条退款通知。返回这条通知 */
  completeRefund(
    outRefundNo: string,
    plan?: NotificationPlan & { status?: WechatPayRefundStatus },
  ): WechatPayNotification;
  /** 直接排一条通知，不改订单与退款的状态：造迟到的、与当前状态对不上的通知 */
  enqueue(notification: WechatPayNotification, plan?: NotificationPlan): void;
  /** 改待投队列的顺序。不给参数就整个倒过来 */
  reorder(order?: (queue: QueuedNotification[]) => QueuedNotification[]): void;
  /** 指定查单结果：之后查这个单号都返回它；给 null 取消 */
  setQueryResult(outTradeNo: string, result: WechatPayTransaction | ProviderFailure | null): void;
  /** 把到点的通知按队列顺序投给处理器，返回投了几次 */
  deliverDue(): Promise<number>;
  /** 把一条通知编成回调请求（请求头带替身的签名）。造被篡改的回调时用 */
  encode(notification: WechatPayNotification): { headers: Record<string, string>; rawBody: string };
}

const SERIAL = "FAKE_PUB_KEY_ID";

function signatureOf(timestamp: string, nonce: string, rawBody: string): string {
  return createHash("sha256")
    .update(`fake-wechatpay\n${timestamp}\n${nonce}\n${rawBody}\n`)
    .digest("hex");
}

/** 北京时间的日期，YYYY-MM-DD */
function beijingDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function transactionOf(order: FakeWechatPayOrder): WechatPayTransaction {
  return {
    outTradeNo: order.outTradeNo,
    tradeState: order.tradeState,
    transactionId: order.transactionId,
    amountFen: order.amountFen,
    payerOpenid: order.payerOpenid,
    attach: order.attach,
    successAt: order.successAt,
  };
}

/** 回调请求体里的日期是字符串，解出来要变回 Date */
function reviveNotification(parsed: WechatPayNotification): WechatPayNotification {
  if (parsed.kind !== "transaction" || parsed.transaction.successAt === undefined) return parsed;
  return {
    ...parsed,
    transaction: { ...parsed.transaction, successAt: new Date(parsed.transaction.successAt) },
  };
}

export function createFakeWechatPay(options: { clock?: FakeClock } = {}): FakeWechatPay {
  const clock = options.clock ?? systemClock;
  const core = createFakeCore<Method>(clock);
  const orders = new Map<string, FakeWechatPayOrder>();
  const refunds = new Map<string, WechatPayRefund>();
  const queue: QueuedNotification[] = [];
  const deliveries: FakeDeliveryRecord[] = [];
  const queryResults = new Map<string, WechatPayTransaction | ProviderFailure>();
  let handler: FakeNotificationHandler | null = null;
  let seq = 0;
  const next = (prefix: string) => `${prefix}-${String((seq += 1)).padStart(6, "0")}`;

  function encode(notification: WechatPayNotification) {
    const rawBody = JSON.stringify(notification);
    const timestamp = String(Math.floor(clock.now().getTime() / 1000));
    const nonce = notification.id;
    return {
      rawBody,
      headers: {
        "wechatpay-timestamp": timestamp,
        "wechatpay-nonce": nonce,
        "wechatpay-serial": SERIAL,
        "wechatpay-signature": signatureOf(timestamp, nonce, rawBody),
      },
    };
  }

  function enqueue(notification: WechatPayNotification, plan: NotificationPlan = {}): void {
    const dueAt = new Date(clock.now().getTime() + (plan.delayMs ?? 0));
    for (let copy = 0; copy < (plan.copies ?? 1); copy += 1) {
      queue.push({ notification, dueAt, attempt: 1 });
    }
  }

  const fake: FakeWechatPay = {
    status: "fake",
    configured: true,
    ...core.control,
    orders,
    refunds,
    queue,
    deliveries,
    retryDelayMs: 15_000,
    maxAttempts: 5,
    encode,
    enqueue,
    onNotification(nextHandler) {
      handler = nextHandler;
    },

    pay(outTradeNo, plan) {
      const order = orders.get(outTradeNo);
      if (!order) throw new Error(`假微信支付：没有商户单号 ${outTradeNo} 的预下单`);
      if (order.tradeState !== "NOTPAY") {
        throw new Error(`假微信支付：${outTradeNo} 现在是 ${order.tradeState}，不能付款`);
      }
      order.tradeState = "SUCCESS";
      order.transactionId = next("fake-txn");
      order.successAt = clock.now();
      const notification: WechatPayNotification = {
        kind: "transaction",
        id: next("fake-notify"),
        transaction: transactionOf(order),
      };
      enqueue(notification, plan);
      return notification;
    },

    completeRefund(outRefundNo, plan = {}) {
      const refund = refunds.get(outRefundNo);
      if (!refund) throw new Error(`假微信支付：没有退款单号 ${outRefundNo}`);
      refund.status = plan.status ?? "SUCCESS";
      const notification: WechatPayNotification = {
        kind: "refund",
        id: next("fake-notify"),
        refund: { ...refund },
      };
      enqueue(notification, plan);
      return notification;
    },

    reorder(order = (current) => [...current].reverse()) {
      const reordered = order([...queue]);
      queue.splice(0, queue.length, ...reordered);
    },

    setQueryResult(outTradeNo, result) {
      if (result === null) queryResults.delete(outTradeNo);
      else queryResults.set(outTradeNo, result);
    },

    async deliverDue() {
      const now = clock.now().getTime();
      const due = queue.filter((item) => item.dueAt.getTime() <= now);
      for (const item of due) {
        queue.splice(queue.indexOf(item), 1);
        let acknowledged = true;
        if (handler) {
          try {
            const answer = await handler({ ...encode(item.notification), attempt: item.attempt });
            acknowledged = answer !== false;
          } catch {
            acknowledged = false;
          }
        }
        deliveries.push({
          notification: item.notification,
          attempt: item.attempt,
          at: clock.now(),
          acknowledged,
        });
        if (!acknowledged && item.attempt < fake.maxAttempts) {
          queue.push({
            notification: item.notification,
            dueAt: new Date(clock.now().getTime() + fake.retryDelayMs),
            attempt: item.attempt + 1,
          });
        }
      }
      return due.length;
    },

    createJsapiOrder: (input) =>
      core.run("createJsapiOrder", input, () => {
        if (!Number.isInteger(input.amountFen) || input.amountFen <= 0) {
          return failed("rejected", "金额要是正的整数分");
        }
        const existing = orders.get(input.outTradeNo);
        if (existing) {
          if (
            existing.amountFen !== input.amountFen ||
            existing.payerOpenid !== input.payerOpenid
          ) {
            return failed("rejected", "商户单号已存在，入参与上一次不同");
          }
          if (existing.tradeState !== "NOTPAY") {
            return failed("rejected", `订单已是 ${existing.tradeState}，不能再预下单`);
          }
          return ok({ prepayId: existing.prepayId });
        }
        const order: FakeWechatPayOrder = {
          ...input,
          prepayId: next("fake-prepay"),
          tradeState: "NOTPAY",
        };
        orders.set(input.outTradeNo, order);
        return ok({ prepayId: order.prepayId });
      }),

    verifyAndDecryptNotification: (input) =>
      core.run("verifyAndDecryptNotification", input, (): ProviderResult<WechatPayNotification> => {
        const headers = Object.fromEntries(
          Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
        );
        const expected = signatureOf(
          headers["wechatpay-timestamp"] ?? "",
          headers["wechatpay-nonce"] ?? "",
          input.rawBody,
        );
        if (headers["wechatpay-signature"] !== expected) {
          return failed("rejected", "验签失败");
        }
        return ok(reviveNotification(JSON.parse(input.rawBody) as WechatPayNotification));
      }),

    queryByOutTradeNo: (input) =>
      core.run("queryByOutTradeNo", input, (): ProviderResult<WechatPayTransaction> => {
        const preset = queryResults.get(input.outTradeNo);
        if (preset !== undefined) return "ok" in preset ? preset : ok({ ...preset });
        const order = orders.get(input.outTradeNo);
        return order ? ok(transactionOf(order)) : failed("rejected", "订单不存在");
      }),

    closeOrder: (input) =>
      core.run("closeOrder", input, (): ProviderResult<{ outcome: "closed" | "paid" }> => {
        const order = orders.get(input.outTradeNo);
        if (!order) return failed("rejected", "订单不存在");
        if (order.tradeState === "SUCCESS" || order.tradeState === "REFUND") {
          return ok({ outcome: "paid" });
        }
        order.tradeState = "CLOSED";
        return ok({ outcome: "closed" });
      }),

    createRefund: (input) =>
      core.run("createRefund", input, () => {
        const existing = refunds.get(input.outRefundNo);
        if (existing) {
          if (existing.outTradeNo !== input.outTradeNo || existing.refundFen !== input.refundFen) {
            return failed("rejected", "退款单号已存在，入参与上一次不同");
          }
          return ok({ ...existing });
        }
        const order = orders.get(input.outTradeNo);
        if (!order) return failed("rejected", "订单不存在");
        if (order.tradeState !== "SUCCESS" && order.tradeState !== "REFUND") {
          return failed("rejected", `订单是 ${order.tradeState}，不能退款`);
        }
        const refunded = [...refunds.values()]
          .filter((refund) => refund.outTradeNo === input.outTradeNo && refund.status !== "CLOSED")
          .reduce((sum, refund) => sum + refund.refundFen, 0);
        if (
          !Number.isInteger(input.refundFen) ||
          input.refundFen <= 0 ||
          refunded + input.refundFen > order.amountFen
        ) {
          return failed("rejected", "退款金额要是正的整数分，累计不超过订单金额");
        }
        const refund: WechatPayRefund = {
          outRefundNo: input.outRefundNo,
          outTradeNo: input.outTradeNo,
          refundId: next("fake-refund"),
          status: "PROCESSING",
          refundFen: input.refundFen,
        };
        refunds.set(input.outRefundNo, refund);
        order.tradeState = "REFUND";
        return ok({ ...refund });
      }),

    fetchTradeBill: (input) =>
      core.run("fetchTradeBill", input, () => {
        const lines = [...orders.values()]
          .filter((order) => order.successAt && beijingDate(order.successAt) === input.billDate)
          .map((order) =>
            [order.successAt?.toISOString(), order.outTradeNo, order.transactionId, order.amountFen]
              .map(String)
              .join(","),
          );
        const text = ["交易时间,商户订单号,微信支付订单号,金额（分）", ...lines].join("\n");
        return ok({ billDate: input.billDate, text });
      }),
  };
  return fake;
}
