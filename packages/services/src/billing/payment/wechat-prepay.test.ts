import { billingOrderContentSchema } from "@liyoxi/contract";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient, BillingOrder, Prisma } from "@liyoxi/db";
import {
  AppError,
  createIdentityContext,
  createIdempotencyContext,
  guardProviderCall,
  isInTransaction,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import { currentSessionOpenid } from "../../identity/index.js";
import { createConfig } from "../../config/index.js";
import { createTenant } from "../../tenant/index.js";
import {
  assembleForTest,
  createFakeProviders,
  createPaymentHarness,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness, FakeWechatPay } from "../../testing/index.js";
import type { PurchaseActor, WechatPayerSession } from "./purchase-context.js";
import { createWechatPrepay } from "./wechat-prepay.js";
import type { WechatPrepayDeps } from "./wechat-prepay.js";
import { recordChannelSuccess } from "./channel-success.js";

const db = useSeededDatabase("services", { max: 1 }),
  appid = "wx0000000000000000",
  mchid = "1900000109";
const client = { platform: "android", appVersion: "1.0.0" };
let prisma: PrismaClient, h: PaymentHarness, provider: FakeWechatPay, deps: WechatPrepayDeps;
let fulfillmentFault: "business" | "infra" | null = null;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma, {
    onStep: () => {
      if (fulfillmentFault)
        throw new AppError(fulfillmentFault === "business" ? "QUOTE_CHANGED" : "ACCOUNT_BUSY");
    },
  });
  const assembly = assembleForTest({ entry: "api" });
  provider = createFakeProviders({ clock: h.clock, beforeCall: guardProviderCall }).wechatPay;
  deps = {
    tx: h.tx,
    clock: h.clock,
    events: h.events,
    payment: h.payment,
    config: createConfig({ db: prisma, clock: h.clock, redis: null }),
    tenant: createTenant({ tx: h.tx, clock: h.clock, flow: h.paymentDeps.flow, assembly }),
    keyring: () => TEST_KEYRING,
    wechatPay: {
      provider,
      appid,
      mchid,
      currentOpenid: (tx, session) => currentSessionOpenid(tx, session, appid),
    },
  };
  await finance("controls", {
    adminCreateOrder: false,
    wechatSingleLimitFen: 100_000_000,
    wechatDailyLimitFen: 100_000_000,
    receiptSecondReviewFen: null,
    shippingReport: false,
  });
}, 120_000);

async function finance(configKey: "controls" | "purchase_policy", payload: Prisma.InputJsonObject) {
  const [staff, reviewer] = await Promise.all([h.make.staff(), h.make.staff()]);
  const id = uuidv7(),
    now = h.clock.now(),
    approvalId = uuidv7();
  await prisma.approvalRequest.create({
    data: {
      id: approvalId,
      kind: "finance_config_change",
      category: "approval",
      subjectType: "finance_config_revision",
      subjectId: id,
      status: "approved",
      summarySnapshot: { title: "微信隔离配置" },
      submitActorType: "staff",
      submitActorId: staff.id,
      submitClient: "admin",
      requesterStaffId: staff.id,
      submittedAt: now,
      decidedAt: now,
      decidedByStaffId: reviewer.id,
      dedupeKey: `finance_config_change:${configKey}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.financeConfigRevision.create({
    data: {
      id,
      configKey,
      payload,
      changeNote: "仅隔离测试的已批准配置",
      approvalRequestId: approvalId,
      effectiveAt: now,
      createdAt: now,
    },
  });
}
async function session(merchantUserId: string): Promise<WechatPayerSession> {
  const id = uuidv7(),
    identityId = uuidv7(),
    now = h.clock.now();
  await prisma.wechatIdentity.create({
    data: {
      id: identityId,
      merchantUserId,
      appid,
      openid: `o_${identityId}`,
      lastLoginAt: now,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.userSession.create({
    data: {
      id,
      merchantUserId,
      wechatIdentityId: identityId,
      tokenHash: Buffer.alloc(32, 0x39),
      lastIp: "198.19.4.1",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
      absoluteExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
    },
  });
  return { sessionId: id, merchantUserId, wechatIdentityId: identityId, consentStamp: null };
}
async function setup() {
  const own = await h.make.merchant({ verified: true });
  const membership = await h.tx.run((tx) =>
    deps.tenant.resolveMembership(tx, { merchantUserId: own.user.id, storeId: own.store.id }),
  );
  if (!membership || membership.role !== "owner") throw new Error("测试老板未建立");
  const actor: PurchaseActor = {
    ctx: createIdentityContext({
      actor: { type: "merchant", id: own.user.id, role: "owner", client: "weapp" },
      entityId: own.entity.id,
      storeId: own.store.id,
    }),
    membership,
  };
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: "pro" } });
  const revision = await prisma.planRevision.findFirstOrThrow({
    where: { planId: plan.id, cancelledAt: null },
    orderBy: { revisionNo: "desc" },
  });
  const amountFen = revision.monthlyFeeFen;
  const order = await h.make.billingOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    status: "pending_payment",
    fulfillmentStatus: "none",
    fulfilledAt: null,
    channel: "wechat_jsapi",
    transferState: null,
    amountFen,
    contentSnapshot: {
      v: 1,
      kind: "plan",
      planId: plan.id,
      planRevisionId: revision.id,
      months: 1,
      cyclePriceFen: amountFen,
      payFen: amountFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo: null,
      quotedAt: h.clock.now().toISOString(),
    },
  });
  return { ...own, order, actor, session: await session(own.user.id) };
}
type Buyer = Awaited<ReturnType<typeof setup>>;
function idem(b: Buyer, key = uuidv7()) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.paymentOrder.wechatPrepay",
    actor: b.actor.ctx.actor,
    key,
    request: { method: "POST", pathParams: { paymentOrderId: b.order.id }, storeId: b.store.id },
    redact: ["payParams"],
  });
}
function prepay(b: Buyer, key = uuidv7(), payer = b.session) {
  return createWechatPrepay(deps)(b.actor, client, b.order.id, {
    idem: idem(b, key),
    session: payer,
  });
}
const receipt = (order: BillingOrder) =>
  prisma.paymentTxn.findFirstOrThrow({
    where: { billingOrderId: order.id },
    orderBy: { attemptNo: "desc" },
  });
const scopedTables = [
  "billing_order",
  "payment_txn",
  "ledger_operation",
  "point_ledger_entry",
  "subscription_term",
  "grant_schedule",
  "point_lot",
  "payment_exception",
  "status_transition",
  "outbox_event",
  "audit_log",
];

// 6聚合：小量真实DB与正式状态链/保存点；渠道IO只有既有typed替身。
describe("微信预下单A/外呼/B与可信成功伴随", () => {
  it("A已提交与未知响应重试保原单号；B后签名，C50和有效prepay复用不再外下单", async () => {
    const b = await setup(),
      key = uuidv7();
    provider.loseResponseNext("createJsapiOrder");
    const create = provider.createJsapiOrder.bind(provider);
    const spy = vi.spyOn(provider, "createJsapiOrder").mockImplementation(async (input) => {
      expect(isInTransaction()).toBe(false);
      // 与业务共用max1连接；能读到created证明没有把外呼塞在A里。
      expect(
        await prisma.paymentTxn.findUnique({ where: { outTradeNo: input.outTradeNo } }),
      ).toMatchObject({ status: "created", amountFen: b.order.amountFen });
      return create(input);
    });
    try {
      await expect(prepay(b, key)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
      const first = await receipt(b.order);
      expect(first).toMatchObject({ status: "created", prepayId: null });
      const result = await prepay(b, key);
      expect(result).toMatchObject({
        replayed: false,
        payParams: { signType: "RSA", package: expect.stringContaining("prepay_id=") },
      });
      expect(await receipt(b.order)).toMatchObject({
        id: first.id,
        status: "prepaid",
        prepayExpiresAt: new Date(h.clock.now().getTime() + 7_200_000),
      });
      const before = await snapshotTables(prisma, scopedTables);
      expect(await prepay(b, key)).toMatchObject({ replayed: true, payParams: null });
      expect(await snapshotTables(prisma, scopedTables)).toEqual(before);
      spy.mockRestore();
      const calls = provider.callsOf("createJsapiOrder").length;
      expect((await prepay(b)).payParams).not.toBeNull();
      expect(provider.callsOf("createJsapiOrder")).toHaveLength(calls);
      const record = await prisma.idempotencyRecord.findFirstOrThrow({
        where: { scope: "m.paymentOrder.wechatPrepay", key },
      });
      expect(record.result).toMatchObject({ payParams: null });
      expect(JSON.stringify(record.result)).not.toContain("explicit-fake-signature");
      expect(await prisma.paymentTxn.count({ where: { billingOrderId: b.order.id } })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("同key占用409；外呼期间尝试关闭令B拒绝并真实关渠道，A技术行保留", async () => {
    const b = await setup(),
      key = uuidv7();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const create = provider.createJsapiOrder.bind(provider);
    const spy = vi.spyOn(provider, "createJsapiOrder").mockImplementation(async (input) => {
      const result = await create(input);
      entered();
      await gate;
      return result;
    });
    const running = prepay(b, key).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await reached;
      await expect(prepay(b, key)).rejects.toMatchObject({ error: "IDEMPOTENCY_IN_PROGRESS" });
      const txn = await receipt(b.order);
      // 模拟独立取消入口已完成的技术关闭，订单仍待支付；不伪造paid。
      await h.tx.run(async (tx) => {
        await lockRows(tx, "billing_order", [b.order.id]);
        await lockRows(tx, "payment_txn", [txn.id]);
        await tx.paymentTxn.update({
          where: { id: txn.id },
          data: { status: "closed", updatedAt: h.clock.now() },
        });
      });
      release();
      expect(await running).toMatchObject({ error: { error: "PAYMENT_ORDER_CLOSED" } });
      expect(provider.orders.get(txn.outTradeNo)?.tradeState).toBe("CLOSED");
      expect(await receipt(b.order)).toMatchObject({
        id: txn.id,
        status: "closed",
        prepayId: null,
      });
      expect(await prisma.billingOrder.findUnique({ where: { id: b.order.id } })).toMatchObject({
        status: "pending_payment",
        paidAmountFen: 0,
      });
      expect(
        await prisma.idempotencyRecord.count({
          where: { scope: "m.paymentOrder.wechatPrepay", key },
        }),
      ).toBe(0);
    } finally {
      release();
      await running;
      spy.mockRestore();
    }
  });

  it("换payer先查关旧单再建第二尝试；金额与回传数据只取服务端", async () => {
    const b = await setup();
    await prepay(b);
    const first = await receipt(b.order),
      secondSession = await session(b.user.id),
      before = provider.calls.length;
    const result = await prepay(b, uuidv7(), secondSession);
    const next = await receipt(b.order);
    expect(result.payParams).not.toBeNull();
    expect(next).toMatchObject({ attemptNo: 2, amountFen: b.order.amountFen, status: "prepaid" });
    expect(next.outTradeNo).not.toBe(first.outTradeNo);
    expect(next.attach).toMatch(
      /^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.N\.[A-Za-z0-9_-]{22}\.1$/,
    );
    expect(await prisma.paymentTxn.findUnique({ where: { id: first.id } })).toMatchObject({
      status: "closed",
    });
    expect(provider.calls.slice(before).map((c) => c.method)).toEqual([
      "queryByOutTradeNo",
      "closeOrder",
      "createJsapiOrder",
      "signMiniProgramPay",
    ]);
    expect(provider.orders.get(next.outTradeNo)).toMatchObject({
      amountFen: b.order.amountFen,
      attach: next.attach,
      payerOpenid: `o_${secondSession.wechatIdentityId}`,
    });
  });

  it("换payer查得已付：可信事实与原入账履约一次，重放不新增资金或历史", async () => {
    const b = await setup();
    await prepay(b);
    const txn = await receipt(b.order),
      key = uuidv7();
    provider.pay(txn.outTradeNo);
    const result = await prepay(b, key, await session(b.user.id));
    expect(result).toMatchObject({
      payParams: null,
      paymentOrder: { status: "paid", fulfillmentStatus: "done" },
    });
    expect(await receipt(b.order)).toMatchObject({
      status: "succeeded",
      appliedAt: h.clock.now(),
      channelAmountFen: b.order.amountFen,
    });
    expect(
      await prisma.ledgerOperation.count({
        where: { entityId: b.entity.id, opKey: `fulfill:billing_order:${b.order.id}` },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: txn.id, eventType: "payment_txn.succeeded" },
      }),
    ).toBe(1);
    expect(
      await prisma.statusTransition.count({ where: { machine: "payment_txn", subjectId: txn.id } }),
    ).toBe(0);
    const before = await snapshotTables(prisma, scopedTables);
    expect(await prepay(b, key)).toMatchObject({ replayed: true, payParams: null });
    const fact = await provider.queryByOutTradeNo({ outTradeNo: txn.outTradeNo });
    if (!fact.ok) throw new Error("替身已付查单失败");
    expect(
      await h.tx.run((tx) =>
        recordChannelSuccess(tx, { clock: h.clock, events: h.events, appid, mchid }, b.actor.ctx, {
          paymentTxnId: txn.id,
          transaction: fact.value,
        }),
      ),
    ).toMatchObject({ replayed: true });
    expect(
      (await h.tx.run((tx) => h.payment.applyPayment(tx, { paymentTxnId: txn.id }))).replayed,
    ).toBe(true);
    expect(await snapshotTables(prisma, scopedTables)).toEqual(before);
  });

  it("不符事实保留成功但不入账；错渠道身份及过期/未配/政策守卫零虚假prepaid", async () => {
    for (const kind of ["amount", "payer", "attach", "identity"] as const) {
      const b = await setup();
      await prepay(b);
      const txn = await receipt(b.order);
      const notification = provider.pay(txn.outTradeNo);
      if (notification.kind !== "transaction") throw new Error("测试不是付款通知");
      provider.setQueryResult(txn.outTradeNo, {
        ...notification.transaction,
        ...(kind === "amount"
          ? { amountFen: b.order.amountFen - 1 }
          : kind === "payer"
            ? { payerOpenid: "explicit-other-payer" }
            : kind === "attach"
              ? { attach: "v1.other-order" }
              : { mchid: "1900000110" }),
      });
      if (kind === "identity") {
        await expect(prepay(b, uuidv7(), await session(b.user.id))).rejects.toMatchObject({
          error: "PROVIDER_UNAVAILABLE",
        });
        expect(await receipt(b.order)).toMatchObject({ status: "prepaid", channelTxnNo: null });
      } else {
        const result = await prepay(b, uuidv7(), await session(b.user.id));
        expect(result).toMatchObject({
          payParams: null,
          paymentOrder: { status: "cancelled" },
        });
        expect(await receipt(b.order)).toMatchObject({ status: "succeeded", appliedAt: null });
        expect(
          await prisma.paymentException.findFirst({ where: { paymentTxnId: txn.id } }),
        ).toMatchObject({
          kind: kind === "amount" ? "amount_mismatch" : "payer_mismatch",
          detectedBy: "apply",
        });
        expect(await prisma.ledgerOperation.count({ where: { entityId: b.entity.id } })).toBe(0);
      }
    }
    // 原成功收款/履约建出真实周期，再准备合法退款外键；不伪造付款终态。
    const refunding = await setup();
    await prepay(refunding);
    const paidTxn = await receipt(refunding.order);
    provider.pay(paidTxn.outTradeNo);
    await prepay(refunding, uuidv7(), await session(refunding.user.id));
    const now = h.clock.now(),
      requester = await h.make.staff(),
      approvalId = uuidv7();
    await prisma.approvalRequest.create({
      data: {
        id: approvalId,
        requestNo: `TK${approvalId.replaceAll("-", "")}`,
        kind: "plan_refund",
        category: "approval",
        subjectType: "billing_order",
        subjectId: refunding.order.id,
        entityId: refunding.entity.id,
        status: "pending",
        summarySnapshot: { title: "预下单退款闸门夹具" },
        requesterStaffId: requester.id,
        submitActorType: "system",
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const refund = await prisma.refundRequest.create({
      data: {
        id: uuidv7(),
        approvalRequestId: approvalId,
        source: "customer_service",
        entityId: refunding.entity.id,
        billingOrderId: refunding.order.id,
        paymentTxnId: paidTxn.id,
        baseAmountFen: refunding.order.amountFen,
        amountFen: refunding.order.amountFen,
        breakdownSnapshot: {},
        ruleCode: "window",
        ruleText: "隔离退款闸门夹具",
        reasonCode: "other",
        status: "pending_approval",
        createdAt: now,
        updatedAt: now,
      },
    });
    const term = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { sourceBillingOrderId: refunding.order.id },
    });
    await prisma.subscriptionTerm.update({
      where: { id: term.id },
      data: { refundRequestId: refund.id, refundRule: "window" },
    });
    const nextOrder = await h.make.billingOrder({
      entityId: refunding.entity.id,
      storeId: refunding.store.id,
      status: "pending_payment",
      amountFen: refunding.order.amountFen,
      contentSnapshot: billingOrderContentSchema.parse(refunding.order.contentSnapshot),
      fulfillmentStatus: "none",
      fulfilledAt: null,
      transferState: null,
      channel: "wechat_jsapi",
    });
    const expired = await setup();
    await prisma.billingOrder.update({
      where: { id: expired.order.id },
      data: { expiresAt: new Date(h.clock.now().getTime() + 60_000) },
    });
    const before = provider.calls.length;
    await expect(prepay({ ...refunding, order: nextOrder })).rejects.toMatchObject({
      error: "PLAN_REFUND_IN_PROGRESS",
    });
    await expect(prepay(expired)).rejects.toMatchObject({ error: "PAYMENT_ORDER_EXPIRED" });
    const notConfigured = {
      ...deps,
      wechatPay: { ...deps.wechatPay!, provider: { ...provider, configured: false } },
    };
    const b = await setup();
    await expect(
      createWechatPrepay(notConfigured)(b.actor, client, b.order.id, {
        idem: idem(b),
        session: b.session,
      }),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    await finance("purchase_policy", {
      rules: [
        {
          when: { entityIds: [b.entity.id] },
          then: { channels: { wechat_jsapi: "off", bank_transfer: "on" } },
        },
      ],
    });
    await expect(prepay(b)).rejects.toMatchObject({ error: "CHANNEL_NOT_ALLOWED" });
    expect(provider.calls).toHaveLength(before);
    expect(
      await prisma.paymentTxn.count({
        where: { billingOrderId: { in: [expired.order.id, b.order.id, nextOrder.id] } },
      }),
    ).toBe(0);
  });

  it("业务受阻保存点保已付并开差异；账户忙回滚入账但保可信成功，再次完成不重复收款", async () => {
    try {
      for (const mode of ["business", "infra"] as const) {
        const b = await setup();
        await prepay(b);
        const txn = await receipt(b.order);
        provider.pay(txn.outTradeNo);
        fulfillmentFault = mode;
        const next = await session(b.user.id);
        if (mode === "business") {
          expect(await prepay(b, uuidv7(), next)).toMatchObject({
            payParams: null,
            paymentOrder: { status: "paid", fulfillmentStatus: "blocked" },
          });
          expect(
            await prisma.paymentException.findFirst({ where: { paymentTxnId: txn.id } }),
          ).toMatchObject({ kind: "fulfillment_blocked" });
          expect(await prisma.subscriptionTerm.count({ where: { entityId: b.entity.id } })).toBe(0);
        } else {
          const key = uuidv7();
          await expect(prepay(b, key, next)).rejects.toMatchObject({ error: "ACCOUNT_BUSY" });
          expect(await prisma.billingOrder.findUnique({ where: { id: b.order.id } })).toMatchObject(
            { status: "pending_payment", fulfillmentStatus: "none", appliedAt: null },
          );
          expect(await receipt(b.order)).toMatchObject({ status: "succeeded", appliedAt: null });
          expect(await prisma.ledgerOperation.count({ where: { entityId: b.entity.id } })).toBe(0);
          fulfillmentFault = null;
          expect(await prepay(b, key, next)).toMatchObject({
            payParams: null,
            paymentOrder: { status: "paid", fulfillmentStatus: "done" },
          });
        }
        expect(
          await prisma.outboxEvent.count({
            where: { aggregateId: txn.id, eventType: "payment_txn.succeeded" },
          }),
        ).toBe(1);
        expect(await prisma.paymentTxn.count({ where: { billingOrderId: b.order.id } })).toBe(1);
        fulfillmentFault = null;
      }
    } finally {
      fulfillmentFault = null;
    }
  });
});
