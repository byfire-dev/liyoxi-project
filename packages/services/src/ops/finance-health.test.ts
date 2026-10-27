import type { PrismaClient } from "@liyoxi/db";
import { beforeEach, expect, it } from "vitest";
import { openPaymentException } from "../billing/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { createPaymentHarness, useSeededDatabase } from "../testing/index.js";
import { createFinanceHealth } from "./finance-health.js";

const db = useSeededDatabase("services", { max: 1 });
beforeEach(() => db.reset(), 60_000);
async function setup() {
  const h = createPaymentHarness(await db.prisma()),
    now = h.clock.now();
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  const certificates = async () => [
    { kind: "merchant_api_cert" as const, expiresAt: new Date(now.getTime() + 40 * 86_400_000) },
  ];
  const options = { db: h.prisma, clock: h.clock, cacheMs: 0, timeoutMs: 1500, certificates };
  const sample = createFinanceHealth(options);
  async function baseline() {
    await h.prisma.$executeRaw`
      INSERT INTO worker_lease(name,holder,holder_version,acquired_at,heartbeat_at)
      VALUES('primary','finance:test','test',clock_timestamp(),clock_timestamp())`;
    await h.prisma.invariantRun.create({
      data: {
        id: uuidv7(),
        mode: "full",
        trigger: "schedule",
        status: "succeeded",
        startedAt: ago(60),
        finishedAt: ago(30),
      },
    });
    await h.prisma.timer.create({
      data: {
        id: uuidv7(),
        kind: "billing.sweep.daily",
        dedupeKey: uuidv7(),
        fireAt: ago(60),
        firedAt: ago(30),
        status: "fired",
      },
    });
  }
  return { ...h, ago, options, baseline, sample };
}

it("真实空库保留未知与0；补合法运行事实后健康，重复GET式采样不写业务", async () => {
  const h = await setup();
  const missing = await createFinanceHealth({ ...h.options, certificates: undefined })();
  expect(missing).toMatchObject({
    status: "degraded",
    unappliedReceipt: { count: 0, oldestAgeSec: null },
    workerHeartbeatAgeSec: null,
    timerLagSec: 0,
    webhookBacklog: { pendingCount: 0, deadCount: 0, oldestPendingAgeSec: null },
    certificates: null,
    billing: {
      sweepLagSec: 0,
      invariantRunAgeSec: null,
      openViolationCount: 0,
      valuationAgeSec: null,
      oldestBlockedFulfillmentSec: 0,
    },
  });
  expect(missing.breaches).toEqual([
    "workerHeartbeatAgeSec",
    "certificates",
    "billing.invariantRunAgeSec",
    "billing.valuationAgeSec",
  ]);
  await h.baseline();
  const before = await h.prisma.timer.findMany({ orderBy: { id: "asc" } });
  const healthy = await h.sample();
  expect(healthy).toMatchObject({
    status: "ok",
    breaches: [],
    billing: {
      invariantRunAgeSec: 30,
      valuationAgeSec: 30,
    },
  });
  expect(healthy.workerHeartbeatAgeSec).toBeGreaterThanOrEqual(0);
  expect(healthy.workerHeartbeatAgeSec).toBeLessThan(60);
  expect(healthy.certificates).toEqual([
    {
      kind: "merchant_api_cert",
      expiresAt: new Date(h.clock.now().getTime() + 40 * 86_400_000).toISOString(),
      daysLeft: 40,
    },
  ]);
  await h.sample();
  expect(await h.prisma.timer.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  expect(await h.prisma.billingOrder.count()).toBe(0);
  expect(await h.prisma.auditLog.count()).toBe(0);
  expect(await h.prisma.outboxEvent.count()).toBe(0);
});

it("真实收款严格10分钟且排除全退和已有差异；成功入账事实不重复计数", async () => {
  const h = await setup();
  await h.baseline();
  await h.make.paymentTxn({ channelSuccessAt: h.ago(600) });
  const old = await h.make.paymentTxn({ channelSuccessAt: h.ago(601) });
  await h.make.paymentTxn({ channelSuccessAt: h.ago(3600), refundedFen: 9900 });
  const handled = await h.make.paymentTxn({ channelSuccessAt: h.ago(7200) });
  await h.tx.run((tx) =>
    openPaymentException(
      tx,
      h.paymentDeps,
      createIdentityContext({ actor: { type: "system", job: "lyxtest.finance" } }),
      {
        kind: "bill_only",
        order: null,
        receipt: handled,
      },
    ),
  );
  await h.make.billingOrder({ paidAt: h.ago(3600) });
  expect((await h.sample()).unappliedReceipt).toEqual({ count: 1, oldestAgeSec: 601 });
  await h.prisma.paymentTxn.update({ where: { id: old.id }, data: { refundedFen: 9900 } });
  expect((await h.sample()).unappliedReceipt).toEqual({ count: 0, oldestAgeSec: null });
  h.clock.advance(1000);
  expect((await h.sample()).unappliedReceipt).toEqual({ count: 1, oldestAgeSec: 601 });
});

it("真实账本/运行/队列事实遵守600秒、26小时、24小时和30天边界", async () => {
  const h = await setup();
  await h.baseline();
  await h.make.billingAccount({ nextDueAt: h.ago(600) });
  await h.make.billingOrder({
    fulfillmentStatus: "blocked",
    fulfilledAt: null,
    paidAt: h.ago(86400),
  });
  await h.prisma.invariantRun.updateMany({
    data: { startedAt: h.ago(93601), finishedAt: h.ago(93600) },
  });
  await h.prisma.timer.updateMany({ data: { fireAt: h.ago(93601), firedAt: h.ago(93600) } });
  await h.prisma.timer.create({
    data: {
      id: uuidv7(),
      kind: "lyxtest.finance",
      dedupeKey: uuidv7(),
      fireAt: h.ago(1000),
      retryAt: h.ago(300),
    },
  });
  const sample = createFinanceHealth({
    ...h.options,
    certificates: async () => [
      { kind: "merchant_api_cert", expiresAt: new Date(h.clock.now().getTime() + 30 * 86_400_000) },
    ],
  });
  expect((await sample()).breaches).toEqual([]);
  h.clock.advance(1000);
  await h.prisma
    .$executeRaw`UPDATE worker_lease SET heartbeat_at=clock_timestamp()-interval '4 minutes',acquired_at=clock_timestamp()-interval '5 minutes'`;
  await h.prisma.invariantViolation.create({
    data: {
      id: uuidv7(),
      code: "billing.I1",
      module: "billing",
      severity: "P1",
      detail: {},
      firstSeenAt: h.clock.now(),
      lastSeenAt: h.clock.now(),
    },
  });
  await h.prisma.webhookEvent.create({
    data: {
      id: uuidv7(),
      provider: "wechatpay",
      eventId: uuidv7(),
      eventType: "TRANSACTION.SUCCESS",
      mode: "inbox",
      receivedAt: new Date(h.clock.now().getTime() - 301_000),
      payloadDigest: Buffer.alloc(32),
      payload: { summary: {} },
      processState: "failed",
      attempts: 1,
      error: "公开测试故障",
      nextAttemptAt: h.clock.now(),
    },
  });
  const breached = await createFinanceHealth({
    ...h.options,
    certificates: async () => [
      { kind: "merchant_api_cert", expiresAt: new Date(h.clock.now().getTime() + 29 * 86_400_000) },
    ],
  })();
  expect(breached.webhookBacklog).toEqual({
    pendingCount: 1,
    deadCount: 0,
    oldestPendingAgeSec: 301,
  });
  expect(breached.breaches).toEqual(
    expect.arrayContaining([
      "workerHeartbeatAgeSec",
      "timerLagSec",
      "webhookBacklog",
      "certificates",
      "billing.sweepLagSec",
      "billing.invariantRunAgeSec",
      "billing.openViolationCount",
      "billing.valuationAgeSec",
      "billing.oldestBlockedFulfillmentSec",
    ]),
  );
});

it("单指标挂起独立超时为null；其余真实SQL完成，缓存合并只读采样", async () => {
  const h = await setup();
  await h.baseline();
  let calls = 0;
  const isolated = new Proxy(h.prisma, {
    get(target, key) {
      if (key !== "$queryRaw") return Reflect.get(target, key, target);
      return (...args: Parameters<PrismaClient["$queryRaw"]>) => {
        calls++;
        if (String(args[0]).includes("FROM payment_txn")) return new Promise(() => {});
        return Reflect.apply(target.$queryRaw, target, args);
      };
    },
  });
  const sample = createFinanceHealth({ ...h.options, db: isolated, cacheMs: 5000 });
  const [first, second] = await Promise.all([sample(), sample()]);
  expect(first).toBe(second);
  expect(first.unappliedReceipt).toBeNull();
  expect(first.breaches).toEqual(["unappliedReceipt"]);
  expect(first.billing.invariantRunAgeSec).toBe(30);
  expect(calls).toBe(9);
  expect(await sample()).toBe(first);
  expect(calls).toBe(9);
});
