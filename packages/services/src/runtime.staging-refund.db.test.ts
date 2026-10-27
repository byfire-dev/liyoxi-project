import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPrismaClient } from "@liyoxi/db";
import { approvalKindsOf } from "./approval/index.js";
import { recordChannelSuccess } from "./billing/index.js";
import { createIdentityContext, loadEnv } from "./kernel/index.js";
import type { AppEnv, Env, TxRunner } from "./kernel/index.js";
import { buildWorkerServices } from "./ops/index.js";
import { createRuntime } from "./runtime.js";
import { createLogger } from "./logger.js";
import { armRecurringSlot, claimTimers } from "./timers/index.js";
import {
  applyReceipt,
  assembleForTest,
  createRefundHarnessForTest,
  fakeKeyEnv,
  merchantCertificateForTest,
  pendingWechatReceipt,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "./testing/index.js";
import type { RefundHarnessForTest } from "./testing/index.js";

const JOB = "stg.pay.autorefund",
  KIND = "staging_pay_refund";
const db = useSeededDatabase("services", { max: 1, label: "stgjob" });
const redis = useTestRedis();
const workers: ReturnType<typeof buildWorkerServices>[] = [];
const apis: ReturnType<typeof createRuntime>[] = [];
const peers: ReturnType<typeof createPrismaClient>[] = [];
let h: RefundHarnessForTest, config: NonNullable<Env["WECHAT_PAY"]>, sequence: number;
beforeEach(async () => {
  await db.reset();
  h = createRefundHarnessForTest(await db.prisma());
  sequence = 0;
  const publicIdentity = merchantCertificateForTest();
  config = {
    appid: h.deps.wechatPay!.appid,
    mchid: h.deps.wechatPay!.mchid,
    merchantSerialNo: publicIdentity.serial,
    merchantPrivateKeyPem: publicIdentity.privateKeyPem,
    apiV3Key: "public-staging-test".padEnd(32, "0"),
    publicKeyId: "PUB_KEY_ID_STGTEST",
    publicKeyPem: publicIdentity.publicKeyPem,
    notifyUrl: "https://example.invalid/hooks/wechatpay",
  };
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const worker of workers.splice(0).reverse()) {
    await worker.shutdownMediaJobs?.();
    worker.closeMediaJobs?.();
    await worker.closeNotify?.();
    await worker.closeAnalytics?.();
    await worker.closeStaff?.();
    await worker.closeSmsHealth?.();
    await worker.closeAlertFacts?.();
    worker.closeApproval?.();
    await worker.closeProfile?.();
    worker.closeInvitations?.();
    worker.closeOrder?.();
    worker.closeBillingTimers?.();
    worker.closePublish?.();
    worker.closeDelivery?.();
    worker.closeWebhooks?.();
    await worker.closeDocs?.();
    await worker.closeMediaDrivers?.();
    await worker.closeStorageDrivers?.();
  }
  for (const api of apis.splice(0).reverse()) await api.close();
  for (const peer of peers.splice(0)) await peer.$disconnect();
  h?.close();
});
function worker(appEnv: AppEnv, entityIds: readonly string[] = [], prisma = h.prisma) {
  const result = buildWorkerServices({
    appEnv,
    prisma,
    clock: h.clock,
    assembly: assembleForTest({ entry: "worker", appEnv }),
    providers: h.provider,
    keys: { WECHAT_PAY: config, ...(appEnv === "stg" ? { STAGING_PAY: { entityIds } } : {}) },
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
  workers.push(result);
  return result;
}
async function api(appEnv: AppEnv, entityIds: readonly string[] = []) {
  // 回放已验证typed Env；不宣称test下公开合成配置是线上密钥/启动自检证明。
  const env: Env = {
    ...loadEnv({ APP_ENV: "test", DATABASE_URL: await db.url(), REDIS_URL: process.env.REDIS_URL }),
    ...fakeKeyEnv(),
    APP_ENV: appEnv,
    WECHAT_PAY: config,
    ...(appEnv === "stg" ? { STAGING_PAY: { entityIds } } : {}),
  };
  const result = createRuntime({
    entry: "api",
    env,
    version: "public-stg-test",
    clock: h.clock,
    providers: h.provider,
    redisKeyPrefix: redis.prefix,
    logger: createLogger({
      svc: "api",
      env: appEnv,
      level: "error",
      version: "public-stg-test",
      destination: { write() {} },
    }),
  });
  apis.push(result);
  return result;
}
async function paid(amountFen = 1, prefix = "TFK") {
  const own = await h.make.merchant({ verified: true });
  const plan = await h.prisma.plan.findUniqueOrThrow({ where: { code: "pro" } });
  const revision = await h.prisma.planRevision.findFirstOrThrow({
    where: { planId: plan.id, cancelledAt: null },
    orderBy: { revisionNo: "desc" },
  });
  const order = await h.make.billingOrder({
    entityId: own.entity.id,
    orderNo: `${prefix}20260105${90000 + ++sequence}`,
    channel: "wechat_jsapi",
    status: "pending_payment",
    transferState: null,
    amountFen,
    contentSnapshot: {
      v: 1,
      kind: "plan",
      planId: plan.id,
      planRevisionId: revision.id,
      months: 1,
      cyclePriceFen: revision.monthlyFeeFen,
      payFen: amountFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo: null,
      quotedAt: h.clock.now().toISOString(),
    },
  });
  const receipt = await pendingWechatReceipt(h, order);
  const pending = await h.provider.wechatPay.createJsapiOrder({
    outTradeNo: receipt.outTradeNo,
    description: "公开实际job隔离样例",
    amountFen,
    payerOpenid: receipt.payerOpenid!,
    attach: receipt.attach!,
    expireAt: order.expiresAt,
  });
  if (!pending.ok) throw new Error("公开替身预下单失败");
  const fact = h.provider.wechatPay.pay(receipt.outTradeNo);
  if (fact.kind !== "transaction") throw new Error("公开替身支付事实缺失");
  await h.tx.run((tx) =>
    recordChannelSuccess(
      tx,
      {
        clock: h.clock,
        events: h.deps.events,
        appid: config.appid,
        mchid: config.mchid,
        exceptions: h.deps,
      },
      createIdentityContext({
        actor: { type: "system", job: "lyxtest.paid" },
        entityId: own.entity.id,
      }),
      {
        paymentTxnId: receipt.id,
        transaction: fact.transaction,
      },
    ),
  );
  await applyReceipt(h, receipt);
  h.clock.advance(600_000);
  return { ...own, order, receipt };
}
const financial = [
  "billing_order",
  "payment_txn",
  "refund_request",
  "refund_txn",
  "approval_request",
  "subscription_term",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "grant_schedule",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
async function slot(owner: ReturnType<typeof buildWorkerServices>) {
  await h.tx.run((tx) => armRecurringSlot(tx, JOB, h.clock.now()));
  const claimed = await h.tx.run((tx) =>
    claimTimers(tx, owner.timers.registry, h.clock.now(), 100),
  );
  const ref = claimed.claimed.find((item) => item.kind === JOB);
  if (!ref) throw new Error("实际预发job未认领");
  return ref;
}
it.each(["prod", "test", "local"] as const)(
  "%s实际API/worker registry与handler都无预发入口，零渠道/业务写",
  async (appEnv) => {
    await paid();
    const before = await snapshotTables(h.prisma, financial);
    const w = worker(appEnv),
      a = await api(appEnv);
    for (const runtime of [w, a]) {
      expect(runtime.assembly.recurringJobs.some((item) => item.kind === JOB)).toBe(false);
      expect(runtime.assembly.recurringJob(JOB)).toBeUndefined();
      // isJob仅表示契约已知名称；正式执行按实际recurringJobs取handler。
      expect(runtime.timers.registry.isJob(JOB)).toBe(true);
      expect(runtime.timers.registry.recurringJobs.some((item) => item.kind === JOB)).toBe(false);
      expect(approvalKindsOf(runtime.assembly).has(KIND)).toBe(false);
    }
    expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(0);
    expect(h.provider.wechatPay.callsOf("queryRefund")).toHaveLength(0);
    expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  },
);
it("真实stg空名单disabled零扫描；取消/关闭后不再写或外呼", async () => {
  const own = await paid();
  const empty = worker("stg");
  const before = await snapshotTables(h.prisma, financial);
  let scans = 0;
  const runTx: TxRunner["run"] = (fn, options) => {
    scans++;
    return h.tx.run(fn, options);
  };
  const controller = new AbortController();
  expect(approvalKindsOf(empty.assembly).has(KIND)).toBe(true);
  expect(
    await empty.assembly
      .recurringJob(JOB)!
      .run({ scheduledFor: h.clock.now(), signal: controller.signal, runTx }),
  ).toEqual({ disabled: true, scanned: 0, handled: 0, skipped: 0 });
  expect(scans).toBe(0);
  const enabled = worker("stg", [own.entity.id]);
  const run = enabled.assembly.recurringJob(JOB)!.run;
  controller.abort();
  await expect(
    run({ scheduledFor: h.clock.now(), signal: controller.signal, runTx }),
  ).rejects.toThrow();
  enabled.closeApproval?.();
  await expect(
    run({ scheduledFor: h.clock.now(), signal: new AbortController().signal, runTx }),
  ).rejects.toThrow("已关闭");
  expect(scans).toBe(0);
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(0);
  expect(h.provider.wechatPay.callsOf("queryRefund")).toHaveLength(0);
});
it("实际API组合根绑定真实system审批与typed名单，正式job处理并重放不增", async () => {
  const own = await paid();
  const a = await api("stg", [own.entity.id]);
  const run = a.assembly.recurringJob(JOB)!.run;
  const context = () => ({
    scheduledFor: h.clock.now(),
    signal: new AbortController().signal,
    runTx: a.tx.run,
  });
  expect(await run(context())).toEqual({ disabled: false, scanned: 1, handled: 1, skipped: 0 });
  expect(await run(context())).toEqual({ disabled: false, scanned: 0, handled: 0, skipped: 0 });
  const request = await h.prisma.refundRequest.findFirstOrThrow({
    where: { billingOrderId: own.order.id },
    include: { approvalRequest: true },
  });
  expect(request).toMatchObject({
    source: "staging_probe",
    isExecutedBySystem: true,
    status: "executing",
    approvalRequest: { kind: KIND, submitActorType: "system", isDecidedBySystem: true },
  });
  expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(1);
});
it("真实worker job运输隔离坏候选仍处理合法单，预筛三保护且不接管原poll意图", async () => {
  const orders = [await paid(1), await paid(100)].sort((a, b) =>
    a.order.id.localeCompare(b.order.id),
  );
  const bad = orders[0]!,
    good = orders[1]!;
  const big = await paid(101),
    normal = await paid(1, "FK"),
    unlisted = await paid();
  const w = worker("stg", [bad.entity.id, good.entity.id, big.entity.id, normal.entity.id]);
  const real = h.provider.wechatPay.createRefund.bind(h.provider.wechatPay);
  vi.spyOn(h.provider.wechatPay, "createRefund").mockImplementation(async (input) => {
    const value = await real(input);
    if (input.outTradeNo === bad.receipt.outTradeNo) throw new Error("公开替身已受理但丢应答");
    return value;
  });
  const ref = await slot(w);
  expect(await w.runTimer(ref)).toBe("failed");
  expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: ref.timerId } })).toMatchObject({
    status: "failed",
    attempts: 1,
  });
  expect(
    await h.prisma.refundTxn.findFirstOrThrow({ where: { billingOrderId: good.order.id } }),
  ).toMatchObject({ status: "processing", submitCount: 1 });
  expect(
    await h.prisma.refundTxn.findFirstOrThrow({ where: { billingOrderId: bad.order.id } }),
  ).toMatchObject({ status: "created", submitCount: 1 });
  expect(
    await h.prisma.refundRequest.count({
      where: { billingOrderId: { in: [big.order.id, normal.order.id, unlisted.order.id] } },
    }),
  ).toBe(0);
  expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(2);
  const run = w.assembly.recurringJob(JOB)!.run;
  expect(
    await run({
      scheduledFor: h.clock.now(),
      signal: new AbortController().signal,
      runTx: h.tx.run,
    }),
  ).toEqual({ disabled: false, scanned: 0, handled: 0, skipped: 0 });
  expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(2);
  expect(w.assembly.timerHandler("rf.poll")).toBeDefined();
});
it("两个真实PG owner竞争三轮仅一申请/原号/回收，重复正式job不增渠道", async () => {
  const peer = createPrismaClient({ connectionString: await db.url(), max: 1 });
  peers.push(peer);
  for (let round = 0; round < 3; round++) {
    const own = await paid();
    const first = worker("stg", [own.entity.id]),
      second = worker("stg", [own.entity.id], peer);
    const ref = await slot(first);
    const outcomes = await Promise.all([first.runTimer(ref), second.runTimer(ref)]);
    expect(outcomes).toContain("fired");
    expect(outcomes.every((value) => ["fired", "stale"].includes(value))).toBe(true);
    const requests = await h.prisma.refundRequest.findMany({
      where: { billingOrderId: own.order.id },
    });
    expect(requests).toHaveLength(1);
    const txns = await h.prisma.refundTxn.findMany({ where: { refundRequestId: requests[0]!.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ submitCount: 1, status: "processing" });
    expect(
      await h.prisma.ledgerOperation.count({
        where: { entityId: own.entity.id, opKey: { startsWith: "revoke:subscription_term:" } },
      }),
    ).toBe(1);
    expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(round + 1);
  }
});
