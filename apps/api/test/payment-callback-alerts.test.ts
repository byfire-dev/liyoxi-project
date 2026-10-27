// 实际支付/退款路由、生产验签与告警 writer；仅渠道材料为现造的公开测试值。
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createFakeWechatPay,
  createPaymentHarness,
  joinPayment,
  pendingPlanOrder,
  pendingWechatReceipt,
} from "@liyoxi/services/testing";
import type { FakeWechatPay } from "@liyoxi/services/testing";
import { billingWechatHookHandlers } from "../src/routes/billing-wechat-hooks.js";
import { billingRefundHookHandlers } from "../src/routes/billing-refund-hook.js";
import { TEST_WEAPP_APPID, useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const h = useTestApi();
const handlers = [...billingWechatHookHandlers, ...billingRefundHookHandlers];
const identity = { appid: TEST_WEAPP_APPID, mchid: "1900000109" };
const routes = [
  {
    operationId: "hooks.wechatpay.transaction.notify",
    path: "/api/v1/hooks/wechatpay/transactions",
    kind: "transaction",
  },
  {
    operationId: "hooks.wechatpay.refund.notify",
    path: "/api/v1/hooks/wechatpay/refunds",
    kind: "refund",
  },
] as const;
type Route = (typeof routes)[number];
type Wire = ReturnType<FakeWechatPay["encode"]>;
let keyPair: Parameters<FakeWechatPay["useWireFormat"]>[0];
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyPair = {
    keyPair: {
      privateKey: pair.privateKey,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  };
});
beforeEach(() => h.db.reset(), 60_000);

async function configured() {
  const api = await h.start({ handlers, wechatPay: identity });
  const pay = api.runtime.providers.wechatPay as FakeWechatPay;
  pay.useWireFormat({ ...identity, ...keyPair });
  return { api, pay };
}
function notification(api: TestApi, route: Route): Parameters<FakeWechatPay["encode"]>[0] {
  return route.kind === "transaction"
    ? {
        kind: "transaction",
        id: uuidv7(),
        transaction: {
          ...identity,
          outTradeNo: "LYXTEST-NONEXISTENT-ORDER",
          transactionId: "LYXTEST-NONEXISTENT-TXN",
          tradeState: "SUCCESS",
          amountFen: 100,
          payerOpenid: "o_public_callback_alert_fixture",
          successAt: api.clock.now(),
        },
      }
    : {
        kind: "refund",
        id: uuidv7(),
        refund: {
          outTradeNo: "LYXTEST-NONEXISTENT-ORDER",
          outRefundNo: "LYXTEST-NONEXISTENT-REFUND",
          refundId: "LYXTEST-REMOTE-REFUND",
          status: "SUCCESS",
          refundFen: 100,
          successAt: api.clock.now(),
        },
      };
}
async function send(api: TestApi, route: Route, wire: Wire) {
  const requestId = uuidv7();
  const response = await api.request(route.path, {
    method: "POST",
    body: wire.rawBody,
    headers: { ...wire.headers, "Content-Type": "application/json", "X-Request-Id": requestId },
  });
  expect(response.headers.get("X-Request-Id")).toBe(requestId);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return { response, requestId };
}
async function fact(route: Route, status: number, requestId: string, occurrences: number) {
  const db = await h.db.prisma();
  const row = await db.alertEvent.findFirstOrThrow({
    where: { fingerprint: `billing.callback_failed:${route.operationId}` },
  });
  expect(row).toMatchObject({
    rule: "billing.callback_failed",
    kind: "event",
    severity: "P1",
    status: "open",
    occurrences,
    lastValue: {
      provider: "wechatpay",
      operationId: route.operationId,
      httpStatus: status,
      reqId: requestId,
    },
  });
  expect(Object.keys(row.lastValue as object).sort()).toEqual([
    "httpStatus",
    "operationId",
    "provider",
    "reqId",
  ]);
}
async function emptyReceipts() {
  const db = await h.db.prisma();
  expect(await db.webhookEvent.count()).toBe(0);
  expect(await db.paymentTxn.count()).toBe(0);
  expect(await db.refundTxn.count()).toBe(0);
  expect(await db.ledgerOperation.count()).toBe(0);
}

it("两路非探测坏签名及已签名超期401，首错即实际P1并保留原P2验签告警", async () => {
  for (const mode of ["signature", "expired"] as const) {
    const { api, pay } = await configured();
    const observations: { route: Route; requestId: string }[] = [];
    try {
      const wires = routes.map((route) => pay.encode(notification(api, route)));
      if (mode === "expired") api.clock.advance(301_000);
      for (const [i, route] of routes.entries()) {
        const wire = wires[i]!;
        const { response, requestId } = await send(api, route, {
          ...wire,
          ...(mode === "signature" ? { rawBody: `${wire.rawBody} ` } : {}),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          code: "FAIL",
          message: mode === "signature" ? "WEBHOOK_SIGNATURE_INVALID" : "WEBHOOK_TIMESTAMP_SKEWED",
        });
        observations.push({ route, requestId });
      }
    } finally {
      // 实际所属 writer 排空后核持久事实，不用假端口或轮询等待掩盖未落库。
      await api.runtime.close();
    }
    for (const { route, requestId } of observations)
      await fact(route, 401, requestId, mode === "signature" ? 1 : 2);
    const db = await h.db.prisma();
    expect(
      await db.alertEvent.findFirstOrThrow({ where: { fingerprint: "webhook.failing:wechatpay" } }),
    ).toMatchObject({ severity: "P2", occurrences: mode === "signature" ? 2 : 4 });
    await emptyReceipts();
  }
});

it("两路SIGNTEST在验签、未知serial、缺头及未启用404均拒绝，全部告警为零", async () => {
  const { api, pay } = await configured();
  try {
    for (const route of routes) {
      const wire = pay.encode(notification(api, route), { probe: true });
      for (const headers of [
        wire.headers,
        { ...wire.headers, "Wechatpay-Serial": "PUB_KEY_ID_UNKNOWN" },
        { "Wechatpay-Signature": wire.headers["Wechatpay-Signature"]! },
      ]) {
        const { response } = await send(api, route, { ...wire, headers });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: "FAIL" });
      }
    }
  } finally {
    await api.runtime.close();
  }
  const disabled = await h.start({ handlers });
  try {
    for (const route of routes) {
      const { response } = await send(disabled, route, {
        rawBody: "{}",
        headers: { "Wechatpay-Signature": "WECHATPAY/SIGNTEST/public-disabled-probe" },
      });
      expect(response.status).toBe(404);
    }
  } finally {
    await disabled.runtime.close();
  }
  expect(await (await h.db.prisma()).alertEvent.count()).toBe(0);
  await emptyReceipts();
});

it("两路未配置404与真实验签通过解密失败500仍按最终协议首错P1且不泄敏", async () => {
  for (const mode of ["disabled", "decrypt"] as const) {
    const { api, pay } =
      mode === "disabled"
        ? { api: await h.start({ handlers }), pay: undefined }
        : await configured();
    const observations: { route: Route; requestId: string }[] = [];
    const foreign = createFakeWechatPay({ clock: api.clock });
    // 同一RSA公钥，另一把公开假APIv3 key：真正验签通过，真正GCM解密失败。
    foreign.useWireFormat({
      ...identity,
      ...keyPair,
      apiV3Key: "11111111111111111111111111111111",
    });
    try {
      for (const route of routes) {
        const wire = pay
          ? foreign.encode(notification(api, route))
          : { rawBody: "{}", headers: {} };
        const { response, requestId } = await send(api, route, wire);
        expect(response.status).toBe(mode === "disabled" ? 404 : 500);
        expect(await response.json()).toMatchObject({
          code: "FAIL",
          message: mode === "disabled" ? "WEBHOOK_SOURCE_DISABLED" : "WEBHOOK_DECRYPT_FAILED",
        });
        observations.push({ route, requestId });
      }
    } finally {
      await api.runtime.close();
    }
    for (const { route, requestId } of observations)
      await fact(route, mode === "disabled" ? 404 : 500, requestId, mode === "disabled" ? 1 : 2);
    const persisted = JSON.stringify(await (await h.db.prisma()).alertEvent.findMany());
    expect(persisted).not.toContain("WECHATPAY/SIGNTEST/");
    expect(persisted).not.toContain("o_public_callback_alert_fixture");
    expect(persisted).not.toContain("11111111111111111111111111111111");
    await emptyReceipts();
  }
});

it("真实付款锁等待令T1失败但T1′收件200，首次failed与随后真实入账均零首错P1", async () => {
  const { api, pay } = await configured();
  const db = await h.db.prisma();
  try {
    await runSeed({ tx: api.runtime.tx, clock: api.clock });
    const payment = createPaymentHarness(db, { clock: api.clock });
    const own = await payment.make.merchant({ verified: true });
    const order = await pendingPlanOrder(payment, {
      entityId: own.entity.id,
      channel: "wechat_jsapi",
      amountFen: 100,
    });
    const receipt = await pendingWechatReceipt(payment, order);
    expect(
      await pay.createJsapiOrder({
        outTradeNo: receipt.outTradeNo,
        description: "公开假渠道资金告警边界",
        amountFen: receipt.amountFen,
        payerOpenid: receipt.payerOpenid!,
        attach: receipt.attach!,
        expireAt: order.expiresAt,
      }),
    ).toMatchObject({ ok: true });
    const event = pay.pay(receipt.outTradeNo);
    const wire = pay.encode(event);
    const peer = await joinPayment(payment, await h.db.url());
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = peer.tx.run(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT id FROM billing_order WHERE id=$1::uuid FOR UPDATE",
        order.id,
      );
      signalLocked();
      await released;
    });
    try {
      await Promise.race([locked, holding]);
      const { response } = await send(api, routes[0], wire);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(
        await db.webhookEvent.findFirstOrThrow({ where: { eventId: event.id } }),
      ).toMatchObject({ mode: "inbox", processState: "failed", attempts: 1 });
      expect(await db.paymentTxn.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
        status: "created",
        channelSuccessAt: null,
      });
      expect(await db.ledgerOperation.count()).toBe(0);
    } finally {
      release();
      try {
        await holding;
      } finally {
        await peer.close();
      }
    }
    const { response } = await send(api, routes[0], wire);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(await db.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: "paid",
      fulfillmentStatus: "done",
      paidAmountFen: 100,
    });
    expect(
      await db.ledgerOperation.count({ where: { opKey: `fulfill:billing_order:${order.id}` } }),
    ).toBe(1);
  } finally {
    await api.runtime.close();
  }
  expect(await db.alertEvent.count({ where: { rule: "billing.callback_failed" } })).toBe(0);
}, 30_000);
