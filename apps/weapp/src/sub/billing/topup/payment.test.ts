import { expect, it, vi } from "vitest";
import { executePayment, type PaymentParams } from "@/lib/platform";
import { billingPayment, billingPolicy } from "../../../../shots/billing-fixtures";
import { createPaymentIntent } from "./payment";

const params: PaymentParams = {
  timeStamp: "1",
  nonceStr: "synthetic",
  package: "prepay_id=synthetic",
  signType: "RSA",
  paySign: "synthetic",
};
function waiting() {
  return {
    ...billingPayment("bank-waiting"),
    channel: "wechat_jsapi" as const,
    actions: ["wechat-prepay", "sync", "cancel"],
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  let valid = true,
    now = 0,
    key = 0;
  const api = {
    detail: vi.fn(async (_id: string) => waiting()),
    policy: vi.fn(async () => ({
      ...billingPolicy,
      channels: billingPolicy.channels.map((c) => ({ ...c, isEnabled: true })),
    })),
    prepay: vi.fn(async (_id: string, _key: string) => ({
      paymentOrder: waiting(),
      payParams: params as PaymentParams | null,
      replayed: false,
    })),
    sync: vi.fn(async (_id: string) => waiting()),
    cancel: vi.fn(async (_id: string, _key: string) => ({
      outcome: "cancelling" as "cancelling" | "paid" | "cancelled",
      paymentOrder: waiting(),
    })),
  };
  const onSuccess = vi.fn(),
    pay = vi.fn(async (_params: PaymentParams, success: () => void) => {
      success();
      return "success" as const;
    });
  const intent = createPaymentIntent({
    api,
    current: () => valid,
    key: () => `intent-${++key}`,
    now: () => now,
    pay,
    onSuccess,
  });
  return {
    api,
    intent,
    pay,
    onSuccess,
    invalidate() {
      valid = false;
    },
    advance() {
      now += 3000;
    },
  };
}
it("真实平台参数完整传递，success同步触发订阅点位但不改付款事实；H5零平台调用", async () => {
  const success = vi.fn(),
    request = vi.fn((value: PaymentParams, cb: { success(): void }) => {
      expect(value).toEqual(params);
      cb.success();
      expect(success).toHaveBeenCalledOnce();
    });
  expect(await executePayment(params, { supported: true, request }, success)).toBe("success");
  expect(await executePayment(params, { supported: false, request }, success)).toBe("unsupported");
  expect(request).toHaveBeenCalledOnce();
  expect(success).toHaveBeenCalledOnce();
});
it.each([
  ["requestPayment:fail cancel", "cancelled"],
  ["requestPayment:fail unknown", "failed"],
] as const)("平台 %s 分为 %s，不触发成功订阅", async (message, outcome) => {
  const success = vi.fn();
  expect(
    await executePayment(
      params,
      { supported: true, request: (_, cb) => cb.fail(message) },
      success,
    ),
  ).toBe(outcome);
  expect(success).not.toHaveBeenCalled();
});
it("平台同步抛错仅返回失败，不泄露错误或签名内容", async () => {
  expect(
    await executePayment(
      params,
      {
        supported: true,
        request() {
          throw new Error("sensitive");
        },
      },
      vi.fn(),
    ),
  ).toBe("failed");
});
it("同点击同步加锁，平台success仍只回读后端pending，不乐观到账", async () => {
  const h = setup(),
    held = deferred<ReturnType<typeof waiting>>();
  h.api.detail.mockReturnValueOnce(held.promise);
  const first = h.intent.pay("real-order");
  expect(h.intent.pending).toBe(true);
  expect(await h.intent.pay("real-order")).toBeUndefined();
  held.resolve(waiting());
  const result = await first;
  expect(result?.order.status).toBe("pending_payment");
  expect(h.pay).toHaveBeenCalledOnce();
  expect(h.onSuccess).toHaveBeenCalledOnce();
  expect(h.api.detail).toHaveBeenCalledTimes(2);
  expect(h.api.prepay).toHaveBeenCalledWith("real-order", "intent-1");
  expect(h.intent.pending).toBe(false);
});
it("C50 null先查单，仍pending用新key签发一次；不缓存payParams", async () => {
  const h = setup(),
    calls: string[] = [];
  h.api.detail.mockImplementation(async () => {
    calls.push("detail");
    return waiting();
  });
  h.api.prepay.mockImplementation(async (_id, key) => {
    calls.push(`prepay:${key}`);
    return {
      paymentOrder: waiting(),
      payParams: key === "intent-1" ? null : params,
      replayed: key === "intent-1",
    };
  });
  await h.intent.pay("kept-order");
  expect(calls).toEqual(["detail", "prepay:intent-1", "detail", "prepay:intent-2", "detail"]);
  expect(h.pay).toHaveBeenCalledOnce();
  await h.intent.pay("kept-order");
  expect(h.api.prepay).toHaveBeenLastCalledWith("kept-order", "intent-3");
});
it("null后的真实已付款零新签发/平台调用；第二次仍null不循环", async () => {
  const h = setup();
  h.api.prepay.mockResolvedValue({ paymentOrder: waiting(), payParams: null, replayed: true });
  h.api.detail
    .mockResolvedValueOnce(waiting())
    .mockResolvedValueOnce({ ...waiting(), status: "paid" });
  expect((await h.intent.pay("id"))?.order.status).toBe("paid");
  expect(h.api.prepay).toHaveBeenCalledOnce();
  expect(h.pay).not.toHaveBeenCalled();
  const other = setup();
  other.api.prepay.mockResolvedValue({ paymentOrder: waiting(), payParams: null, replayed: true });
  await other.intent.pay("id");
  expect(other.api.prepay).toHaveBeenCalledTimes(2);
  expect(other.pay).not.toHaveBeenCalled();
});
it.each(["offline_contract", "hidden"] as const)("最新%s策略零签发与平台调用", async (mode) => {
  const h = setup();
  h.api.policy.mockResolvedValue({ ...billingPolicy, mode });
  await h.intent.pay("id");
  expect(h.api.prepay).not.toHaveBeenCalled();
  expect(h.pay).not.toHaveBeenCalled();
});
it("最新渠道disabled/未配与服务端actions缺失均不调用平台", async () => {
  const h = setup();
  h.api.policy.mockResolvedValue(billingPolicy);
  await h.intent.pay("id");
  expect(h.api.prepay).not.toHaveBeenCalled();
  h.api.detail.mockResolvedValue({ ...waiting(), actions: [] });
  await h.intent.pay("id");
  expect(h.pay).not.toHaveBeenCalled();
});
it("ctxRev/角色/卸载失效后平台迟到success零订阅和零后续回查", async () => {
  const h = setup(),
    held = deferred<"success">();
  let callback!: () => void;
  h.pay.mockImplementation((_p, cb) => {
    callback = cb;
    return held.promise;
  });
  const first = h.intent.pay("id");
  await vi.waitFor(() => expect(h.pay).toHaveBeenCalledOnce());
  h.invalidate();
  callback();
  held.resolve("success");
  expect(await first).toBeUndefined();
  expect(h.onSuccess).not.toHaveBeenCalled();
  expect(h.api.detail).toHaveBeenCalledOnce();
});
it("隐藏释放旧锁；旧finally不能解开新请求锁，失败后可恢复", async () => {
  const h = setup(),
    old = deferred<ReturnType<typeof waiting>>(),
    next = deferred<ReturnType<typeof waiting>>();
  h.api.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const one = h.intent.pay("old");
  h.intent.invalidate();
  const two = h.intent.pay("new");
  old.resolve(waiting());
  expect(await one).toBeUndefined();
  expect(h.intent.pending).toBe(true);
  next.resolve(waiting());
  await two;
  expect(h.intent.pending).toBe(false);
  h.api.detail.mockRejectedValueOnce(new Error("offline"));
  await expect(h.intent.pay("new")).rejects.toThrow("offline");
  expect(h.intent.pending).toBe(false);
  await h.intent.pay("new");
});
it("主动sync每单3秒且取消三种outcome完全使用服务端结果", async () => {
  const h = setup();
  await h.intent.sync("id");
  await h.intent.sync("id");
  expect(h.api.sync).toHaveBeenCalledOnce();
  h.advance();
  await h.intent.sync("id");
  expect(h.api.sync).toHaveBeenCalledTimes(2);
  for (const outcome of ["paid", "cancelled", "cancelling"] as const) {
    const order = {
      ...waiting(),
      status: outcome === "cancelling" ? ("pending_payment" as const) : outcome,
    };
    h.api.cancel.mockResolvedValue({ outcome, paymentOrder: order });
    expect((await h.intent.cancel("id"))?.order).toEqual(order);
  }
});
