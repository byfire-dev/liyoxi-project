import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakeWechatPay } from "../../testing/index.js";
import type { FakeWechatPay, FakeWechatPayDelivery } from "../../testing/index.js";
import type { WechatPayNotification } from "../types.js";
import { FC_LABEL, FC_PARAMS, FC_TIMEOUT_MS } from "./__fixtures__/fc.js";
import { generateIdentity } from "./__fixtures__/wechatpay-server.js";
import type { TestIdentity } from "./__fixtures__/wechatpay-server.js";
import { createApiV3Keyring, createVerifierTable } from "./keyring.js";
import { verifyAndDecrypt } from "./notification.js";
import type { NotificationDeps } from "./notification.js";

// 假微信支付发出的真实结构通知，由真实驱动验签解密（X-04 任务书 第 7 节第 6 条 ④、第 7 条）。
// 替身的签名与加密是照官方文档另写的一份，不引驱动的代码：两边对得上才算数。

const START = new Date("2026-10-04T02:00:00.000Z");
let identity: TestIdentity;

beforeAll(() => {
  identity = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000000");
});

function manualClock() {
  let now = START.getTime();
  return { now: () => new Date(now), advance: (ms: number) => void (now += ms) };
}

/** 一个切到真实结构的替身，与照它的材料配好的真实驱动的回调入口 */
function wired() {
  const clock = manualClock();
  const pay = createFakeWechatPay({ clock });
  const wire = pay.useWireFormat({ keyPair: identity });
  const deps: NotificationDeps = {
    verifiers: createVerifierTable([{ serial: wire.serial, pem: wire.publicKeyPem }]),
    keyring: createApiV3Keyring({ kid: "fake", key: wire.apiV3Key }),
    now: clock.now,
  };
  return { clock, pay, wire, deps };
}

interface OrderPlan {
  amountFen: number;
  attach: string | undefined;
  copies: number;
  refund: { status: "SUCCESS" | "ABNORMAL" | "CLOSED"; refundFen: number; copies: number } | null;
}

const orderPlanArb: fc.Arbitrary<OrderPlan> = fc
  .record({
    amountFen: fc.integer({ min: 1, max: 100_000_000 }),
    attach: fc.option(fc.string({ unit: "binary", minLength: 1, maxLength: 40 }), {
      nil: undefined,
    }),
    copies: fc.integer({ min: 1, max: 4 }),
    refund: fc.option(
      fc.record({
        status: fc.constantFrom("SUCCESS" as const, "ABNORMAL" as const, "CLOSED" as const),
        portion: fc.integer({ min: 1, max: 100 }),
        copies: fc.integer({ min: 1, max: 3 }),
      }),
      { nil: null },
    ),
  })
  .map(({ refund, ...order }) => ({
    ...order,
    refund: refund && {
      status: refund.status,
      refundFen: Math.max(1, Math.floor((order.amountFen * refund.portion) / 100)),
      copies: refund.copies,
    },
  }));

/** 照计划下单、付款、退款，把通知都排进队列。返回替身报出的每条通知 */
async function enact(pay: FakeWechatPay, plans: OrderPlan[]): Promise<WechatPayNotification[]> {
  const created: WechatPayNotification[] = [];
  for (const [index, plan] of plans.entries()) {
    const outTradeNo = `FK-${String(index).padStart(4, "0")}`;
    await pay.createJsapiOrder({
      outTradeNo,
      description: "性质测试",
      amountFen: plan.amountFen,
      payerOpenid: `openid-${index}`,
      attach: plan.attach,
    });
    created.push(pay.pay(outTradeNo, { copies: plan.copies }));
    if (!plan.refund) continue;
    const outRefundNo = `TK-${String(index).padStart(4, "0")}`;
    const { refundFen, status, copies } = plan.refund;
    await pay.createRefund({ outTradeNo, outRefundNo, refundFen, totalFen: plan.amountFen });
    created.push(pay.completeRefund(outRefundNo, { status, copies }));
  }
  return created;
}

describe(`property: 替身的通知由真实驱动验签解密（${FC_LABEL}）`, () => {
  it(
    "property: 任意通知序列做任意乱序与重复，每条都能验签解密，同一事件的通知 id 不变",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(orderPlanArb, { minLength: 1, maxLength: 4 }),
          fc.array(fc.nat(), { minLength: 32, maxLength: 32 }),
          fc.boolean(),
          async (plans, order, retryOnce) => {
            const { pay, deps, clock } = wired();
            const created = await enact(pay, plans);
            const expectedDeliveries = pay.queue.length;
            // 任意乱序：按给定的权重重排整个队列
            pay.reorder((queue) =>
              queue
                .map((item, index) => ({ item, weight: order[index % order.length] ?? 0, index }))
                .sort((a, b) => a.weight - b.weight || a.index - b.index)
                .map(({ item }) => item),
            );
            const seen: Array<{ id: string; body: string; value: string }> = [];
            let failedOnce = !retryOnce;
            pay.onNotification(async (delivery: FakeWechatPayDelivery) => {
              const result = verifyAndDecrypt(deps, delivery);
              if (!result.ok) throw new Error(`真实驱动没有通过：${result.kind}`);
              // 两份实现给出同一条通知
              const viaFake = await pay.verifyAndDecryptNotification(delivery);
              expect(viaFake).toEqual({ ok: true, value: result.notification });
              seen.push({
                id: result.id,
                body: delivery.rawBody,
                value: JSON.stringify(result.notification),
              });
              // 再加一种重复：头一条应答失败，过后重投
              if (!failedOnce) {
                failedOnce = true;
                return false;
              }
              return true;
            });
            await pay.deliverDue();
            clock.advance(pay.retryDelayMs);
            await pay.deliverDue();

            expect(seen).toHaveLength(expectedDeliveries + (retryOnce ? 1 : 0));
            expect(pay.deliveries.filter((record) => !record.acknowledged)).toHaveLength(
              retryOnce ? 1 : 0,
            );
            // 每条通知的每次投递：id、请求体、解出来的内容都相同；不同的通知 id 不同
            const byId = new Map<string, Set<string>>();
            for (const { id, body, value } of seen) {
              byId.set(id, (byId.get(id) ?? new Set()).add(`${body}\n${value}`));
            }
            expect([...byId.keys()].sort()).toEqual(created.map((item) => item.id).sort());
            for (const variants of byId.values()) expect(variants.size).toBe(1);
            // 解出来的内容就是替身报出的那条通知
            for (const notification of created) {
              const decoded = seen.find((item) => item.id === notification.id)?.value;
              expect(JSON.parse(decoded ?? "null")).toEqual(
                JSON.parse(JSON.stringify(notification)),
              );
            }
          },
        ),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );
});

describe("替身的通知由真实驱动判别", () => {
  it("支付成功、退款成功、退款异常、退款关闭：都通过，事件类型与内容对得上", async () => {
    const { pay, deps } = wired();
    const created = await enact(pay, [
      {
        amountFen: 19900,
        attach: "v1.e.o.N.r.12",
        copies: 1,
        refund: { status: "SUCCESS", refundFen: 19900, copies: 1 },
      },
      {
        amountFen: 500,
        attach: undefined,
        copies: 1,
        refund: { status: "ABNORMAL", refundFen: 100, copies: 1 },
      },
      {
        amountFen: 29,
        attach: undefined,
        copies: 1,
        refund: { status: "CLOSED", refundFen: 29, copies: 1 },
      },
    ]);
    const results = created.map((notification) => verifyAndDecrypt(deps, pay.encode(notification)));
    expect(results.map((result) => (result.ok ? result.eventType : result.kind))).toEqual([
      "TRANSACTION.SUCCESS",
      "REFUND.SUCCESS",
      "TRANSACTION.SUCCESS",
      "REFUND.ABNORMAL",
      "TRANSACTION.SUCCESS",
      "REFUND.CLOSED",
    ]);
    expect(results.map((result) => (result.ok ? result.notification : null))).toEqual(created);
    expect(results[0]).toMatchObject({
      kid: "fake",
      summary: { outTradeNo: "FK-0000", state: "SUCCESS", amountFen: 19900 },
    });
  });

  it("探测签名：验签失败并标记为探测；过了 5 分钟的投递：时间戳超限", async () => {
    const { pay, deps, clock } = wired();
    const [notification] = await enact(pay, [
      { amountFen: 100, attach: undefined, copies: 1, refund: null },
    ]);
    if (!notification) throw new Error("没有通知");
    expect(verifyAndDecrypt(deps, pay.encode(notification, { probe: true }))).toMatchObject({
      ok: false,
      kind: "signature_invalid",
      probe: true,
    });
    const stale = pay.encode(notification);
    clock.advance(5 * 60_000 + 1000);
    expect(verifyAndDecrypt(deps, stale)).toMatchObject({ ok: false, kind: "timestamp_skewed" });
    expect(verifyAndDecrypt(deps, pay.encode(notification))).toMatchObject({ ok: true });
  });

  it("另一个替身（另一把密钥）发来的通知：验签不过", async () => {
    const { pay, deps } = wired();
    const stranger = createFakeWechatPay();
    stranger.useWireFormat();
    const [notification] = await enact(stranger, [
      { amountFen: 100, attach: undefined, copies: 1, refund: null },
    ]);
    if (!notification) throw new Error("没有通知");
    expect(verifyAndDecrypt(deps, stranger.encode(notification))).toMatchObject({
      ok: false,
      kind: "signature_invalid",
    });
    expect(pay.wire?.serial).toBe(stranger.wire?.serial);
  });

  it("替身缺省的格式（没切到真实结构）：真实驱动不认", async () => {
    const { deps } = wired();
    const plain = createFakeWechatPay();
    const [notification] = await enact(plain, [
      { amountFen: 100, attach: undefined, copies: 1, refund: null },
    ]);
    if (!notification) throw new Error("没有通知");
    expect(verifyAndDecrypt(deps, plain.encode(notification))).toMatchObject({ ok: false });
  });
});
