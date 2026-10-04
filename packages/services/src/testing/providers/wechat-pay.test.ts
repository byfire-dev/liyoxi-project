import { describe, expect, it } from "vitest";

import { createFakeWechatPay } from "./wechat-pay.js";
import type { FakeWechatPayDelivery } from "./wechat-pay.js";

// 假微信支付的用例（W0-19 任务书 第 7 节第 7 条）：能编排回调的延迟、重复、乱序、失败与查单结果；
// 同一商户单号重复预下单返回同一结果。

function manualClock(start = "2026-10-04T02:00:00.000Z") {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

const ORDER = {
  outTradeNo: "FK-0001",
  description: "标准版套餐",
  amountFen: 19900,
  payerOpenid: "openid-1",
  attach: "payment:0001",
};

/** 一个假微信支付，加一个把收到的回调都解出来记下的处理器 */
function setup() {
  const clock = manualClock();
  const pay = createFakeWechatPay({ clock });
  const received: Array<{ id: string; kind: string; attempt: number; at: string }> = [];
  pay.onNotification(async (delivery) => {
    const decoded = await pay.verifyAndDecryptNotification(delivery);
    if (!decoded.ok) throw new Error(decoded.message);
    received.push({
      id: decoded.value.id,
      kind: decoded.value.kind,
      attempt: delivery.attempt,
      at: clock.now().toISOString(),
    });
  });
  return { clock, pay, received };
}

describe("预下单", () => {
  it("同一商户单号重复预下单：返回同一结果，只有一张订单", async () => {
    const { pay } = setup();
    const first = await pay.createJsapiOrder(ORDER);
    const second = await pay.createJsapiOrder(ORDER);
    const third = await pay.createJsapiOrder({ ...ORDER, description: "换了描述" });
    expect(first).toEqual({ ok: true, value: { prepayId: "fake-prepay-000001" } });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(pay.orders.size).toBe(1);
    expect(pay.callsOf("createJsapiOrder")).toHaveLength(3);
  });

  it("同号但金额或付款人不同：拒绝，原订单不动", async () => {
    const { pay } = setup();
    await pay.createJsapiOrder(ORDER);
    expect(await pay.createJsapiOrder({ ...ORDER, amountFen: 29900 })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(await pay.createJsapiOrder({ ...ORDER, payerOpenid: "openid-2" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(pay.orders.get("FK-0001")?.amountFen).toBe(19900);
  });

  it("金额不是正的整数分：拒绝", async () => {
    const { pay } = setup();
    for (const amountFen of [0, -1, 1.5]) {
      expect(await pay.createJsapiOrder({ ...ORDER, amountFen })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    }
    expect(pay.orders.size).toBe(0);
  });

  it("已支付、已关闭的单号不能再预下单", async () => {
    const { pay } = setup();
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");
    expect(await pay.createJsapiOrder(ORDER)).toMatchObject({ ok: false, reason: "rejected" });
    await pay.createJsapiOrder({ ...ORDER, outTradeNo: "FK-0002" });
    await pay.closeOrder({ outTradeNo: "FK-0002" });
    expect(await pay.createJsapiOrder({ ...ORDER, outTradeNo: "FK-0002" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
  });
});

describe("回调的编排", () => {
  it("不编排：付款后下一次投递就到，内容是支付成功", async () => {
    const { pay, clock } = setup();
    const deliveries: FakeWechatPayDelivery[] = [];
    pay.onNotification((delivery) => void deliveries.push(delivery));
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");
    expect(await pay.deliverDue()).toBe(1);
    expect(deliveries).toHaveLength(1);
    const decoded = await pay.verifyAndDecryptNotification(deliveries[0]!);
    expect(decoded).toEqual({
      ok: true,
      value: {
        kind: "transaction",
        id: "fake-notify-000003",
        transaction: {
          outTradeNo: "FK-0001",
          tradeState: "SUCCESS",
          transactionId: "fake-txn-000002",
          amountFen: 19900,
          payerOpenid: "openid-1",
          attach: "payment:0001",
          successAt: clock.now(),
        },
      },
    });
    expect(await pay.deliverDue()).toBe(0);
  });

  it("延迟：通知晚到，拨动时钟到点才投", async () => {
    const { pay, clock, received } = setup();
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001", { delayMs: 5_000 });
    expect(await pay.deliverDue()).toBe(0);
    clock.advance(4_999);
    expect(await pay.deliverDue()).toBe(0);
    expect(received).toEqual([]);
    clock.advance(1);
    expect(await pay.deliverDue()).toBe(1);
    expect(received.map((item) => item.at)).toEqual(["2026-10-04T02:00:05.000Z"]);
    // 通知没到之前，查单已经是支付成功：回调晚到时靠查单兜底
    expect(await pay.queryByOutTradeNo({ outTradeNo: "FK-0001" })).toMatchObject({
      ok: true,
      value: { tradeState: "SUCCESS" },
    });
  });

  it("重复：同一条通知投三次，通知编号相同", async () => {
    const { pay, received } = setup();
    await pay.createJsapiOrder(ORDER);
    const notification = pay.pay("FK-0001", { copies: 3 });
    expect(await pay.deliverDue()).toBe(3);
    expect(received.map((item) => item.id)).toEqual([
      notification.id,
      notification.id,
      notification.id,
    ]);
    expect(pay.deliveries.map((item) => item.attempt)).toEqual([1, 1, 1]);
  });

  it("乱序：退款通知早于支付通知", async () => {
    const { pay, clock, received } = setup();
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001", { delayMs: 60_000 });
    await pay.createRefund({
      outTradeNo: "FK-0001",
      outRefundNo: "TK-0001",
      refundFen: 19900,
      totalFen: 19900,
    });
    pay.completeRefund("TK-0001");
    expect(await pay.deliverDue()).toBe(1);
    clock.advance(60_000);
    expect(await pay.deliverDue()).toBe(1);
    expect(received.map((item) => item.kind)).toEqual(["refund", "transaction"]);
  });

  it("乱序：reorder() 把待投队列倒过来，也可以自己给顺序", async () => {
    const { pay, received } = setup();
    for (const outTradeNo of ["FK-A", "FK-B", "FK-C"]) {
      await pay.createJsapiOrder({ ...ORDER, outTradeNo });
    }
    const ids = ["FK-A", "FK-B", "FK-C"].map((outTradeNo) => pay.pay(outTradeNo).id);
    pay.reorder();
    await pay.deliverDue();
    expect(received.map((item) => item.id)).toEqual([ids[2], ids[1], ids[0]]);

    received.length = 0;
    for (const id of ids)
      pay.enqueue({ ...pay.deliveries.find((d) => d.notification.id === id)!.notification });
    pay.reorder((queue) => [queue[1]!, queue[2]!, queue[0]!]);
    await pay.deliverDue();
    expect(received.map((item) => item.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("乱序：关单之后到达支付成功通知", async () => {
    const { pay, received } = setup();
    await pay.createJsapiOrder(ORDER);
    expect(await pay.closeOrder({ outTradeNo: "FK-0001" })).toEqual({
      ok: true,
      value: { outcome: "closed" },
    });
    // 订单在替身里已关，通知却说支付成功：直接排一条与当前状态对不上的通知
    pay.enqueue({
      kind: "transaction",
      id: "late-notify",
      transaction: { outTradeNo: "FK-0001", tradeState: "SUCCESS", amountFen: 19900 },
    });
    await pay.deliverDue();
    expect(received.map((item) => item.id)).toEqual(["late-notify"]);
    expect(pay.orders.get("FK-0001")?.tradeState).toBe("CLOSED");
  });

  it("失败：处理器应答失败，隔 retryDelayMs 重投，投递次数递增", async () => {
    const { pay, clock } = setup();
    const attempts: number[] = [];
    pay.onNotification((delivery) => {
      attempts.push(delivery.attempt);
      if (delivery.attempt === 1) return false; // 应答失败
      if (delivery.attempt === 2) throw new Error("处理器崩了"); // 抛错同样算应答失败
      return true;
    });
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");

    expect(await pay.deliverDue()).toBe(1);
    expect(await pay.deliverDue()).toBe(0); // 重投还没到点
    clock.advance(15_000);
    expect(await pay.deliverDue()).toBe(1);
    clock.advance(15_000);
    expect(await pay.deliverDue()).toBe(1);
    clock.advance(15_000);
    expect(await pay.deliverDue()).toBe(0); // 第三次应答成功，不再投

    expect(attempts).toEqual([1, 2, 3]);
    expect(pay.deliveries.map((item) => item.acknowledged)).toEqual([false, false, true]);
    expect(pay.queue).toEqual([]);
  });

  it("失败：一直应答失败，投满 maxAttempts 次就停", async () => {
    const { pay, clock } = setup();
    pay.maxAttempts = 3;
    pay.retryDelayMs = 1_000;
    pay.onNotification(() => false);
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");
    let delivered = 0;
    for (let round = 0; round < 10; round += 1) {
      delivered += await pay.deliverDue();
      clock.advance(1_000);
    }
    expect(delivered).toBe(3);
    expect(pay.deliveries.map((item) => item.attempt)).toEqual([1, 2, 3]);
  });

  it("失败：回调被改过，验签不过", async () => {
    const { pay } = setup();
    await pay.createJsapiOrder(ORDER);
    const { headers, rawBody } = pay.encode(pay.pay("FK-0001"));
    expect(await pay.verifyAndDecryptNotification({ headers, rawBody })).toMatchObject({
      ok: true,
    });
    expect(
      await pay.verifyAndDecryptNotification({ headers, rawBody: rawBody.replace("19900", "1") }),
    ).toEqual({ ok: false, reason: "rejected", message: "验签失败" });
    expect(
      await pay.verifyAndDecryptNotification({
        headers: { ...headers, "wechatpay-signature": "WECHATPAY/SIGNTEST/probe" },
        rawBody,
      }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    // 请求头的大小写不影响验签
    const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect(await pay.verifyAndDecryptNotification({ headers: upper, rawBody })).toMatchObject({
      ok: true,
    });
  });

  it("没登记处理器：只记投递记录", async () => {
    const pay = createFakeWechatPay();
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");
    expect(await pay.deliverDue()).toBe(1);
    expect(pay.deliveries).toHaveLength(1);
    expect(pay.deliveries[0]?.acknowledged).toBe(true);
  });
});

describe("接口调用的失败与延迟", () => {
  it("失败：预下单报不可用，订单没有建；重试成功", async () => {
    const { pay } = setup();
    pay.failNext("createJsapiOrder");
    expect(await pay.createJsapiOrder(ORDER)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(pay.orders.size).toBe(0);
    expect(await pay.createJsapiOrder(ORDER)).toMatchObject({ ok: true });
    expect(pay.callsOf("createJsapiOrder")).toHaveLength(2);
  });

  it("延迟：退款已经生效，应答晚到", async () => {
    const { pay, clock } = setup();
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");
    pay.delayNext("createRefund", 8_000);
    let settled = false;
    const pending = pay
      .createRefund({
        outTradeNo: "FK-0001",
        outRefundNo: "TK-0001",
        refundFen: 100,
        totalFen: 19900,
      })
      .finally(() => {
        settled = true;
      });
    expect(pay.refunds.has("TK-0001")).toBe(true); // 外部侧已经处理了
    expect(pay.pendingCalls()).toBe(1);
    clock.advance(7_999);
    expect(pay.tick()).toBe(0);
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    expect(pay.tick()).toBe(1);
    expect(await pending).toMatchObject({ ok: true, value: { status: "PROCESSING" } });
  });
});

describe("查单结果", () => {
  it("缺省照订单的实际状态；没有的单号返回 rejected", async () => {
    const { pay } = setup();
    await pay.createJsapiOrder(ORDER);
    expect(await pay.queryByOutTradeNo({ outTradeNo: "FK-0001" })).toMatchObject({
      ok: true,
      value: { tradeState: "NOTPAY", amountFen: 19900, attach: "payment:0001" },
    });
    expect(await pay.queryByOutTradeNo({ outTradeNo: "FK-none" })).toEqual({
      ok: false,
      reason: "rejected",
      message: "订单不存在",
    });
  });

  it("指定结果：查这个单号都返回它；可以是各种状态，也可以是失败；给 null 取消", async () => {
    const { pay } = setup();
    await pay.createJsapiOrder(ORDER);
    for (const tradeState of ["USERPAYING", "PAYERROR", "SUCCESS", "CLOSED", "REFUND"] as const) {
      pay.setQueryResult("FK-0001", { outTradeNo: "FK-0001", tradeState });
      expect(await pay.queryByOutTradeNo({ outTradeNo: "FK-0001" })).toEqual({
        ok: true,
        value: { outTradeNo: "FK-0001", tradeState },
      });
    }
    pay.setQueryResult("FK-0001", { ok: false, reason: "unavailable", message: "查单超时" });
    expect(await pay.queryByOutTradeNo({ outTradeNo: "FK-0001" })).toEqual({
      ok: false,
      reason: "unavailable",
      message: "查单超时",
    });
    pay.setQueryResult("FK-0001", null);
    expect(await pay.queryByOutTradeNo({ outTradeNo: "FK-0001" })).toMatchObject({
      ok: true,
      value: { tradeState: "NOTPAY" },
    });
  });
});

describe("关单、退款、账单", () => {
  it("关单：未支付的关掉；已支付的返回 paid；没有的单号返回 rejected", async () => {
    const { pay } = setup();
    await pay.createJsapiOrder(ORDER);
    await pay.createJsapiOrder({ ...ORDER, outTradeNo: "FK-0002" });
    pay.pay("FK-0002");
    expect(await pay.closeOrder({ outTradeNo: "FK-0001" })).toEqual({
      ok: true,
      value: { outcome: "closed" },
    });
    expect(await pay.closeOrder({ outTradeNo: "FK-0001" })).toEqual({
      ok: true,
      value: { outcome: "closed" },
    });
    expect(await pay.closeOrder({ outTradeNo: "FK-0002" })).toEqual({
      ok: true,
      value: { outcome: "paid" },
    });
    expect(await pay.closeOrder({ outTradeNo: "FK-none" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(() => pay.pay("FK-0001")).toThrow("现在是 CLOSED，不能付款");
  });

  it("退款：同一退款单号只生效一次；累计不超过订单金额；未支付的不能退", async () => {
    const { pay } = setup();
    await pay.createJsapiOrder(ORDER);
    const refund = {
      outTradeNo: "FK-0001",
      outRefundNo: "TK-0001",
      refundFen: 10000,
      totalFen: 19900,
    };
    expect(await pay.createRefund(refund)).toMatchObject({ ok: false, reason: "rejected" });
    pay.pay("FK-0001");
    const first = await pay.createRefund(refund);
    expect(first).toEqual({
      ok: true,
      value: {
        outRefundNo: "TK-0001",
        outTradeNo: "FK-0001",
        refundId: "fake-refund-000004",
        status: "PROCESSING",
        refundFen: 10000,
      },
    });
    expect(await pay.createRefund(refund)).toEqual(first);
    expect(pay.refunds.size).toBe(1);
    expect(await pay.createRefund({ ...refund, refundFen: 1 })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(
      await pay.createRefund({ ...refund, outRefundNo: "TK-0002", refundFen: 9901 }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(
      await pay.createRefund({ ...refund, outRefundNo: "TK-0002", refundFen: 9900 }),
    ).toMatchObject({ ok: true });
    expect(pay.orders.get("FK-0001")?.tradeState).toBe("REFUND");
  });

  it("退款结果：缺省成功，也可以是异常；各发一条退款通知", async () => {
    const { pay, received } = setup();
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");
    await pay.deliverDue();
    await pay.createRefund({
      outTradeNo: "FK-0001",
      outRefundNo: "TK-0001",
      refundFen: 100,
      totalFen: 19900,
    });
    const abnormal = pay.completeRefund("TK-0001", { status: "ABNORMAL" });
    const success = pay.completeRefund("TK-0001");
    expect(abnormal).toMatchObject({ kind: "refund", refund: { status: "ABNORMAL" } });
    expect(success).toMatchObject({ kind: "refund", refund: { status: "SUCCESS" } });
    await pay.deliverDue();
    expect(received.map((item) => item.kind)).toEqual(["transaction", "refund", "refund"]);
    expect(() => pay.completeRefund("TK-none")).toThrow("没有退款单号 TK-none");
  });

  it("账单：按北京时间的日期取当天支付成功的订单", async () => {
    const clock = manualClock("2026-10-03T15:59:00.000Z"); // 北京时间 10 月 3 日 23:59
    const pay = createFakeWechatPay({ clock });
    await pay.createJsapiOrder(ORDER);
    pay.pay("FK-0001");
    clock.advance(2 * 60_000); // 北京时间 10 月 4 日 00:01
    await pay.createJsapiOrder({ ...ORDER, outTradeNo: "FK-0002", amountFen: 500 });
    pay.pay("FK-0002");

    const third = await pay.fetchTradeBill({ billDate: "2026-10-03" });
    const fourth = await pay.fetchTradeBill({ billDate: "2026-10-04" });
    if (!third.ok || !fourth.ok) throw new Error("账单没取到");
    expect(third.value.text.split("\n")).toEqual([
      "交易时间,商户订单号,微信支付订单号,金额（分）",
      "2026-10-03T15:59:00.000Z,FK-0001,fake-txn-000002,19900",
    ]);
    expect(fourth.value.text.split("\n")).toHaveLength(2);
    expect(fourth.value.text).toContain("FK-0002");
  });
});
