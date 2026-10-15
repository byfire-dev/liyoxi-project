import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AlertInput } from "../../kernel/index.js";
import type { PrismaClient } from "@liyoxi/db";
import {
  AppError,
  createIdentityContext,
  createIdempotencyContext,
  guardProviderCall,
  noopAlerts,
  uuidv7,
} from "../../kernel/index.js";
import { createConfig } from "../../config/index.js";
import { createTenant } from "../../tenant/index.js";
import { createWebhooks } from "../../security/index.js";
import { claimTimers, runTimer, createTimers } from "../../timers/index.js";
import {
  assembleForTest,
  createFakeProviders,
  createPaymentHarness,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../../testing/index.js";
import type { FakeWechatPay, PaymentHarness } from "../../testing/index.js";
import { createWechatChannel } from "./wechat-channel.js";
import type { WechatChannel, WechatChannelDeps } from "./wechat-channel.js";
import { createWechatPaymentSource } from "./channel-webhook.js";
import { bindPaymentChannel } from "./channel-registration.js";
import { wechatOrderAttach } from "./channel-success.js";
import { paymentInvariants } from "./invariants.js";
import { purchaseInvariants } from "./purchase-registration.js";
import type { PurchaseActor } from "./purchase-context.js";
const db = useSeededDatabase("services", { max: 1 }),
  appid = "wx0000000000000000",
  mchid = "1900000109",
  client = { platform: "android", appVersion: "1.0.0" };
const system = createIdentityContext({ actor: { type: "system", job: "lyxtest.wechat_channel" } });
let prisma: PrismaClient,
  h: PaymentHarness,
  provider: FakeWechatPay,
  deps: WechatChannelDeps,
  channel: WechatChannel,
  unbind: () => void;
let fault: "infra" | "business" | null = null;
const raised: AlertInput[] = [];
const alerts = {
  raise: async (input: AlertInput) => {
    raised.push(input);
  },
};
const assembly = assembleForTest({ entry: "worker" });
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma, {
    onApplyStep: () => {
      if (fault === "infra") throw new AppError("ACCOUNT_BUSY");
    },
    onStep: () => {
      if (fault === "business") throw new AppError("QUOTE_CHANGED");
    },
  });
  h.clock.set(new Date());
  provider = createFakeProviders({ clock: h.clock, beforeCall: guardProviderCall }).wechatPay;
  provider.useWireFormat({ appid, mchid });
  deps = {
    tx: h.tx,
    clock: h.clock,
    flow: h.paymentDeps.flow,
    timers: createTimers({ assembly }),
    bizNo: h.paymentDeps.bizNo,
    events: h.events,
    payment: h.payment,
    tenant: createTenant({ tx: h.tx, clock: h.clock, flow: h.paymentDeps.flow, assembly }),
    config: createConfig({ db: prisma, clock: h.clock, redis: null }),
    keyring: () => TEST_KEYRING,
    wechatPay: {
      provider,
      appid,
      mchid,
      currentOpenid: async () => {
        throw new Error("本测试不预下单");
      },
    },
  };
  channel = createWechatChannel(deps);
  unbind = bindPaymentChannel(channel);
}, 120000);
afterAll(() => unbind?.());
async function setup() {
  const own = await h.make.merchant({ verified: true });
  const membership = await h.tx.run((tx) =>
    deps.tenant.resolveMembership(tx, { merchantUserId: own.user.id, storeId: own.store.id }),
  );
  if (!membership) throw new Error("未建立测试成员");
  const actor: PurchaseActor = {
    ctx: createIdentityContext({
      actor: { type: "merchant", id: own.user.id, role: "owner", client: "weapp" },
      entityId: own.entity.id,
      storeId: own.store.id,
    }),
    membership,
  };
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: "pro" } }),
    revision = await prisma.planRevision.findFirstOrThrow({
      where: { planId: plan.id, cancelledAt: null },
      orderBy: { revisionNo: "desc" },
    });
  const order = await h.make.billingOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    status: "pending_payment",
    fulfillmentStatus: "none",
    fulfilledAt: null,
    transferState: null,
    channel: "wechat_jsapi",
    amountFen: revision.monthlyFeeFen,
    contentSnapshot: {
      v: 1,
      kind: "plan",
      planId: plan.id,
      planRevisionId: revision.id,
      months: 1,
      cyclePriceFen: revision.monthlyFeeFen,
      payFen: revision.monthlyFeeFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo: null,
      quotedAt: h.clock.now().toISOString(),
    },
  });
  const receipt = await h.make.paymentTxn({
    entityId: own.entity.id,
    billingOrderId: order.id,
    status: "created",
    channel: "wechat_jsapi",
    amountFen: order.amountFen,
    outTradeNo: `${order.orderNo}-01-${uuidv7().slice(-6).toUpperCase()}`,
    payerOpenid: `o_${own.user.id}`,
    attach: wechatOrderAttach(order),
  });
  expect(
    await provider.createJsapiOrder({
      outTradeNo: receipt.outTradeNo,
      description: "隔离测试",
      amountFen: receipt.amountFen,
      payerOpenid: receipt.payerOpenid!,
      attach: receipt.attach!,
      expireAt: order.expiresAt,
    }),
  ).toMatchObject({ ok: true });
  return { ...own, actor, order, receipt };
}
type Buyer = Awaited<ReturnType<typeof setup>>;
function idem(b: Buyer, key = uuidv7()) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.paymentOrder.cancel",
    actor: b.actor.ctx.actor,
    key,
    request: { method: "POST", pathParams: { paymentOrderId: b.order.id }, storeId: b.store.id },
  });
}
function hooks() {
  return createWebhooks({
    tx: h.tx,
    clock: h.clock,
    events: h.events,
    alerts,
    sources: [
      createWechatPaymentSource({
        provider: () => provider,
        identity: () => ({ appid, mchid }),
        channel: () => channel,
        alerts,
      }),
    ],
  });
}
async function receive(hook: ReturnType<typeof hooks>, wire: ReturnType<FakeWechatPay["encode"]>) {
  const receipt = await hook.prepare("wechatpay", {
    rawBody: Buffer.from(wire.rawBody),
    headers: wire.headers,
    method: "POST",
    operationId: "hooks.wechatpay.transaction.notify",
  });
  if (receipt.kind === "reply") return receipt;
  return hook.accept(receipt, system);
}
const tables = [
  "billing_order",
  "payment_txn",
  "payment_exception",
  "ledger_operation",
  "point_ledger_entry",
  "subscription_term",
  "grant_schedule",
  "point_lot",
  "status_transition",
  "outbox_event",
  "audit_log",
];
async function invariants(entityId: string) {
  for (const rule of [
    ...paymentInvariants,
    ...purchaseInvariants.filter((r) => r.code === "payment.I12"),
  ])
    expect(
      await h.tx.run((tx) => rule.run!(tx, { entityIds: [entityId] }, { now: h.clock.now() })),
    ).toEqual([]);
}

describe("微信渠道真实收件/查关单/正式任务共用唯一入账", () => {
  it("原始签名回调提交事实后内联入账；回调/同步/兜底/扫描重放零新增", async () => {
    // 微信 wire 使用整秒；让本例查单与签名通知代表同一时间精度的渠道事实。
    h.clock.set(new Date(Math.floor(h.clock.now().getTime() / 1000) * 1000));
    const b = await setup(),
      event = provider.pay(b.receipt.outTradeNo),
      wire = provider.encode(event),
      hook = hooks();
    expect(await receive(hook, wire)).toMatchObject({ status: 200, body: "" });
    expect(
      await prisma.paymentTxn.findUniqueOrThrow({ where: { id: b.receipt.id } }),
    ).toMatchObject({ status: "succeeded", appliedAt: null });
    await channel.inlineWebhook(event.id);
    expect(
      await prisma.billingOrder.findUniqueOrThrow({ where: { id: b.order.id } }),
    ).toMatchObject({
      status: "paid",
      fulfillmentStatus: "done",
      paidPaymentTxnId: b.receipt.id,
      paidAmountFen: b.order.amountFen,
    });
    const saved = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: "wechatpay", eventId: event.id } },
    });
    expect(saved).toMatchObject({
      mode: "inline",
      processState: "processed",
      attempts: 0,
      keyVersion: "fake-v1",
    });
    expect(JSON.stringify(saved.payload)).not.toMatch(/openid|payer/i);
    const before = await snapshotTables(prisma, tables);
    expect(await receive(hook, wire)).toMatchObject({ status: 200 });
    await channel.inlineWebhook(event.id);
    expect((await channel.sync(b.actor, client, b.order.id)).status).toBe("paid");
    await h.tx.run((tx) =>
      assembly.subscriber("billing.applyPaymentFallback")!.handle(tx, {
        id: uuidv7(),
        type: "payment_txn.succeeded",
        payload: { v: 1, paymentTxnId: b.receipt.id },
      }),
    );
    await assembly
      .recurringJob("tx.unapplied_scan")!
      .run({ scheduledFor: h.clock.now(), signal: new AbortController().signal, runTx: h.tx.run });
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    expect(
      await prisma.ledgerOperation.count({
        where: { opKey: `fulfill:billing_order:${b.order.id}` },
      }),
    ).toBe(1);
    await invariants(b.entity.id);
  });
  it("篡改/探测/未知来源不入账；T1失败保存密文failed并以kid真实重解密后补偿", async () => {
    const b = await setup(),
      event = provider.pay(b.receipt.outTradeNo),
      wire = provider.encode(event),
      hook = hooks();
    expect(await receive(hook, { ...wire, rawBody: wire.rawBody + " " })).toMatchObject({
      status: 401,
    });
    expect(await receive(hook, provider.encode(event, { probe: true }))).toMatchObject({
      status: 401,
    });
    expect(await prisma.webhookEvent.count({ where: { eventId: event.id } })).toBe(0);
    const spy = vi.spyOn(channel, "record").mockRejectedValue(new Error("本轮受控T1失败"));
    try {
      for (let attempt = 0; attempt < 5; attempt++)
        expect(await receive(hook, wire)).toMatchObject({ status: 200 });
    } finally {
      spy.mockRestore();
    }
    const row = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: "wechatpay", eventId: event.id } },
    });
    expect(row).toMatchObject({
      mode: "inbox",
      processState: "failed",
      attempts: 5,
      processedAt: null,
    });
    expect(JSON.stringify(row.payload)).not.toContain(b.receipt.payerOpenid!);
    expect(
      await prisma.paymentTxn.findUniqueOrThrow({ where: { id: b.receipt.id } }),
    ).toMatchObject({ status: "created" });
    expect(raised).toContainEqual(
      expect.objectContaining({ rule: "webhook.failing", severity: "P1" }),
    );
    h.clock.advance(6 * 60 * 60000 + 1);
    expect(await hook.scan()).toBe(1);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      processState: "processed",
      attempts: 5,
    });
    await channel.inlineWebhook(event.id);
    await invariants(b.entity.id);
    const other = await setup(),
      notify = provider.pay(other.receipt.outTradeNo);
    if (notify.kind !== "transaction") throw new Error("不是交易通知");
    // 原签名/密文真实有效，但资源appid不属于该来源配置，须ignored。
    const badSource = createWechatPaymentSource({
      provider: () => provider,
      identity: () => ({ appid: "wx1111111111111111", mchid }),
      channel: () => channel,
      alerts: noopAlerts,
    });
    const wrongHook = createWebhooks({
      tx: h.tx,
      clock: h.clock,
      events: h.events,
      sources: [badSource],
    });
    expect(await receive(wrongHook, provider.encode(notify))).toMatchObject({ status: 200 });
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: "wechatpay", eventId: notify.id } },
      }),
    ).toMatchObject({ processState: "ignored" });
    expect(
      await prisma.paymentTxn.findUniqueOrThrow({ where: { id: other.receipt.id } }),
    ).toMatchObject({ status: "created", appliedAt: null });
  });
  it("sync首次成功留自愈痕迹；取消未知保持待支付、真实全关闭后才取消且同键零外呼", async () => {
    const paid = await setup();
    provider.pay(paid.receipt.outTradeNo);
    expect((await channel.sync(paid.actor, client, paid.order.id)).status).toBe("paid");
    expect(
      await prisma.paymentException.findUniqueOrThrow({
        where: { dedupeKey: `bill_only:${paid.receipt.outTradeNo}` },
      }),
    ).toMatchObject({ status: "auto_healed", detectedBy: "query" });
    const b = await setup();
    provider.failNext("queryByOutTradeNo");
    const unknown = await channel.cancel(b.actor, client, b.order.id, { idem: idem(b) });
    expect(unknown).toMatchObject({
      outcome: "cancelling",
      paymentOrder: { status: "pending_payment" },
    });
    expect(
      await prisma.timer.findFirstOrThrow({
        where: { subjectId: b.order.id, kind: "po.expire", status: "scheduled" },
      }),
    ).toMatchObject({ fireAt: h.clock.now() });
    const key = uuidv7();
    expect(await channel.cancel(b.actor, client, b.order.id, { idem: idem(b, key) })).toMatchObject(
      { outcome: "cancelled", paymentOrder: { status: "cancelled" } },
    );
    expect(provider.orders.get(b.receipt.outTradeNo)?.tradeState).toBe("CLOSED");
    const count = provider.calls.length,
      before = await snapshotTables(prisma, tables);
    expect(await channel.cancel(b.actor, client, b.order.id, { idem: idem(b, key) })).toMatchObject(
      { outcome: "cancelled" },
    );
    expect(provider.calls).toHaveLength(count);
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    await invariants(paid.entity.id);
    await invariants(b.entity.id);
  });
  it("到期真实timer运输查关单；stale/错kind/未来认领零外呼，迟到成功只开差异", async () => {
    // claim按数据库墙钟选到期行；所有业务前置共同在合法历史时点创建。
    const current = h.clock.now();
    h.clock.set(new Date(Date.now() - 32 * 60000));
    let b: Buyer;
    try {
      b = await setup();
    } finally {
      h.clock.set(current);
    }
    const timers = deps.timers;
    const timer = await h.tx.run((tx) =>
      timers.arm(tx, {
        kind: "po.expire",
        subject: { type: "billing_order", id: b.order.id },
        key: `po.expire:billing_order:${b.order.id}`,
        fireAt: new Date(b.order.expiresAt.getTime() + 60000),
        payload: { expiresAt: b.order.expiresAt.toISOString() },
        entityId: b.entity.id,
        storeId: b.store.id,
      }),
    );
    const calls = provider.calls.length;
    await channel.prepareExpire({ timerId: timer.id, dispatchNo: 999, kind: "po.expire" });
    await channel.prepareExpire({ timerId: timer.id, dispatchNo: 0, kind: "unknown" });
    expect(provider.calls).toHaveLength(calls);
    const claimed = await h.tx.run((tx) => claimTimers(tx, timers.registry, h.clock.now()));
    const ref = claimed.claimed.find((r) => r.timerId === timer.id);
    if (!ref) throw new Error("未认领本轮到期单");
    const dueNow = h.clock.now();
    h.clock.set(b.order.createdAt);
    try {
      await channel.prepareExpire(ref);
      expect(provider.calls).toHaveLength(calls);
    } finally {
      h.clock.set(dueNow);
    }
    await channel.prepareExpire({ ...ref, dispatchNo: ref.dispatchNo + 1 });
    expect(provider.calls).toHaveLength(calls);
    expect(
      await runTimer(
        {
          tx: h.tx,
          assembly,
          registry: timers.registry,
          clock: h.clock,
          alerts: noopAlerts,
          beforeRun: channel.prepareExpire,
        },
        ref,
      ),
    ).toBe("fired");
    expect(await prisma.timer.findUniqueOrThrow({ where: { id: timer.id } })).toMatchObject({
      status: "fired",
    });
    expect(
      await prisma.billingOrder.findUniqueOrThrow({ where: { id: b.order.id } }),
    ).toMatchObject({ status: "cancelled", cancelReason: "timeout" });
    expect(
      await prisma.paymentTxn.findUniqueOrThrow({ where: { id: b.receipt.id } }),
    ).toMatchObject({ status: "closed" });
    const late = {
      kind: "transaction" as const,
      id: uuidv7(),
      transaction: {
        appid,
        mchid,
        outTradeNo: b.receipt.outTradeNo,
        tradeState: "SUCCESS" as const,
        transactionId: `late_${uuidv7()}`,
        amountFen: b.order.amountFen,
        payerOpenid: b.receipt.payerOpenid!,
        attach: b.receipt.attach!,
        successAt: h.clock.now(),
      },
    };
    const hook = hooks();
    expect(await receive(hook, provider.encode(late))).toMatchObject({ status: 200 });
    await channel.inlineWebhook(late.id);
    expect(
      await prisma.paymentException.findUniqueOrThrow({
        where: { dedupeKey: `paid_after_cancel:${b.receipt.outTradeNo}` },
      }),
    ).toMatchObject({ status: "open" });
    expect(
      await prisma.paymentTxn.findUniqueOrThrow({ where: { id: b.receipt.id } }),
    ).toMatchObject({ status: "succeeded", appliedAt: null });
    await invariants(b.entity.id);
  });
  it("孤儿只开差异且重放唯一；金额/成功事实矛盾不覆盖旧流水、不虚造权益", async () => {
    const orphan = await h.make.paymentTxn({ entityId: null });
    const first = await h.tx.run((tx) => h.payment.applyPayment(tx, { paymentTxnId: orphan.id }));
    expect(first.result).toMatchObject({
      status: "orphan",
      paymentExceptionId: expect.any(String),
    });
    const before = await snapshotTables(prisma, tables);
    await h.tx.run((tx) => h.payment.applyPayment(tx, { paymentTxnId: orphan.id }));
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    expect(
      await prisma.paymentException.findFirstOrThrow({ where: { paymentTxnId: orphan.id } }),
    ).toMatchObject({ entityId: null, billingOrderId: null, kind: "bill_only", status: "open" });
    const b = await setup(),
      event = provider.pay(b.receipt.outTradeNo);
    if (event.kind !== "transaction") throw new Error("交易通知缺失");
    provider.setQueryResult(b.receipt.outTradeNo, {
      ...event.transaction,
      amountFen: b.order.amountFen + 1,
    });
    expect((await channel.sync(b.actor, client, b.order.id)).status).toBe("cancelled");
    expect(
      await prisma.paymentException.findUniqueOrThrow({
        where: { dedupeKey: `amount_mismatch:${b.receipt.outTradeNo}` },
      }),
    ).toMatchObject({ status: "open" });
    const original = await prisma.paymentTxn.findUniqueOrThrow({ where: { id: b.receipt.id } });
    provider.setQueryResult(b.receipt.outTradeNo, {
      ...event.transaction,
      transactionId: `other_${uuidv7()}`,
    });
    await channel.sync(b.actor, client, b.order.id);
    expect(
      await prisma.paymentTxn.findUniqueOrThrow({ where: { id: b.receipt.id } }),
    ).toMatchObject({
      channelTxnNo: original.channelTxnNo,
      channelAmountFen: original.channelAmountFen,
      appliedAt: null,
    });
    expect(
      await prisma.paymentException.count({
        where: { paymentTxnId: b.receipt.id, kind: "status_mismatch" },
      }),
    ).toBe(1);
    await invariants(b.entity.id);
  });
  it("内联账户忙保成功事实后fallback真正入账；业务拒绝保paid/blocked与差异，取消扫描零后续写", async () => {
    const b = await setup(),
      event = provider.pay(b.receipt.outTradeNo),
      hook = hooks();
    expect(await receive(hook, provider.encode(event))).toMatchObject({ status: 200 });
    fault = "infra";
    try {
      await channel.inlineWebhook(event.id);
    } finally {
      fault = null;
    }
    expect(
      await prisma.paymentTxn.findUniqueOrThrow({ where: { id: b.receipt.id } }),
    ).toMatchObject({ status: "succeeded", appliedAt: null });
    expect(
      await prisma.billingOrder.findUniqueOrThrow({ where: { id: b.order.id } }),
    ).toMatchObject({ status: "pending_payment", paidPaymentTxnId: null });
    await h.tx.run((tx) =>
      assembly.subscriber("billing.applyPaymentFallback")!.handle(tx, {
        id: uuidv7(),
        type: "payment_txn.succeeded",
        payload: { paymentTxnId: b.receipt.id },
      }),
    );
    await invariants(b.entity.id);
    const blocked = await setup(),
      notify = provider.pay(blocked.receipt.outTradeNo);
    expect(await receive(hook, provider.encode(notify))).toMatchObject({ status: 200 });
    fault = "business";
    try {
      await channel.inlineWebhook(notify.id);
    } finally {
      fault = null;
    }
    expect(
      await prisma.billingOrder.findUniqueOrThrow({ where: { id: blocked.order.id } }),
    ).toMatchObject({ status: "paid", fulfillmentStatus: "blocked" });
    expect(
      await prisma.paymentException.findUniqueOrThrow({
        where: { dedupeKey: `fulfillment_blocked:${blocked.receipt.outTradeNo}` },
      }),
    ).toMatchObject({ status: "open" });
    // 此组独立造未决的成功未入账行，定点重跑也真实证明LIMIT前排除。
    const excluded = await h.make.paymentTxn({ entityId: null });
    await h.tx.run((tx) => h.payment.applyPayment(tx, { paymentTxnId: excluded.id }));
    const normal = await setup(),
      fresh = provider.pay(normal.receipt.outTradeNo);
    expect(await receive(hook, provider.encode(fresh))).toMatchObject({ status: 200 });
    const unresolved = new Set(
      (
        await prisma.paymentException.findMany({
          where: { status: { in: ["open", "resolving"] }, paymentTxnId: { not: null } },
          select: { paymentTxnId: true },
        })
      ).map((e) => e.paymentTxnId),
    );
    const apply = vi.spyOn(channel, "apply");
    try {
      expect(
        await assembly.recurringJob("tx.unapplied_scan")!.run({
          scheduledFor: h.clock.now(),
          signal: new AbortController().signal,
          runTx: h.tx.run,
        }),
      ).toEqual({ processed: 1 });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls.every(([, input]) => !unresolved.has(input.paymentTxnId))).toBe(true);
      expect(
        await prisma.billingOrder.findUniqueOrThrow({ where: { id: normal.order.id } }),
      ).toMatchObject({ status: "paid", fulfillmentStatus: "done" });
    } finally {
      apply.mockRestore();
    }
    await invariants(normal.entity.id);
    const before = await snapshotTables(prisma, tables),
      abort = new AbortController();
    abort.abort();
    await expect(
      assembly
        .recurringJob("tx.unapplied_scan")!
        .run({ scheduledFor: h.clock.now(), signal: abort.signal, runTx: h.tx.run }),
    ).rejects.toThrow("收款扫描已取消");
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    await invariants(blocked.entity.id);
  });
});
