import { beforeEach, expect, it } from "vitest";
import { alertsOf, alertsPort, loadEnv } from "../kernel/index.js";
import { createLogger } from "../logger.js";
import { createRuntime } from "../runtime.js";
import {
  assembleForTest,
  createClock,
  createFakeProviders,
  createRecordingPorts,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { buildWorkerServices } from "./worker.js";

const db = useSeededDatabase("services");
const peer = useSeededDatabase("services", { label: "peer" });
const redis = useTestRedis();
beforeEach(async () => {
  await db.reset();
  await peer.reset();
}, 60_000);

async function closeWorker(worker: ReturnType<typeof buildWorkerServices>) {
  await worker.shutdownMediaJobs?.();
  await Promise.allSettled([
    worker.documentConverter?.close(),
    worker.closeNotify(),
    worker.closeAnalytics?.(),
    worker.closeStaff?.(),
    worker.closeSmsHealth?.(),
  ]);
  worker.closeMediaJobs?.();
  worker.closeWebhooks?.();
  worker.closeOrder?.();
  worker.closeBillingTimers?.();
  worker.closePublish?.();
  worker.closeDelivery?.();
  await Promise.allSettled([worker.closeMediaDrivers?.(), worker.closeStorageDrivers?.()]);
  await worker.closeAlertFacts?.();
}

it("API 实际告警端口独立落库，外层业务回滚保留 P1 证据", async () => {
  const clock = createClock(new Date("2026-10-09T04:00:00Z"));
  const env = { ...loadEnv(), DATABASE_URL: await db.url() };
  const runtime = createRuntime({
    entry: "api",
    env,
    clock,
    version: "alert-facts-test",
    redisKeyPrefix: redis.prefix,
    providers: createFakeProviders({ clock }),
    logger: createLogger({
      svc: "api",
      env: "test",
      level: "error",
      version: "alert-facts-test",
      destination: { write: () => {} },
    }),
  });
  try {
    await expect(
      runtime.tx.run(async (tx) => {
        await tx.bizSequence.create({
          data: { prefix: "AF", bizDate: new Date("2026-10-09"), nextVal: 1 },
        });
        await alertsOf(runtime.assembly).raise({
          rule: "evidence.consent_digest_mismatch",
          dimension: "2026-10-08",
          severity: "P1",
          detail: { day: "2026-10-08", rows: 3, phone: "13800138000", rawBody: "private" },
        });
        throw new Error("business rollback");
      }),
    ).rejects.toThrow("business rollback");
    const prisma = await db.prisma();
    expect(await prisma.bizSequence.count({ where: { prefix: "AF" } })).toBe(0);
    expect(await prisma.alertEvent.findMany()).toMatchObject([
      {
        rule: "evidence.consent_digest_mismatch",
        fingerprint: "evidence.consent_digest_mismatch:2026-10-08",
        severity: "P1",
        status: "open",
        kind: "event",
        occurrences: 1,
        lastValue: { day: "2026-10-08", rows: 3 },
      },
    ]);
  } finally {
    await runtime.close();
  }
}, 60_000);

it("两个实际API运行时写各自数据库，关闭一个不重定向另一个的告警", async () => {
  const clock = createClock(new Date("2026-10-09T04:00:00Z"));
  const build = async (database: typeof db, name: string) =>
    createRuntime({
      entry: "api",
      env: { ...loadEnv(), DATABASE_URL: await database.url() },
      clock,
      version: "alert-facts-test",
      providers: createFakeProviders({ clock }),
      redisKeyPrefix: `${redis.prefix}${name}:`,
      logger: createLogger({
        svc: "api",
        env: "test",
        level: "error",
        version: "test",
        destination: { write: () => {} },
      }),
    });
  const first = await build(db, "first"),
    second = await build(peer, "second");
  const input = {
    rule: "evidence.consent_digest_unavailable",
    dimension: "2026-10-08",
    severity: "P2" as const,
    detail: { day: "2026-10-08" },
  };
  try {
    expect(await db.url()).not.toBe(await peer.url());
    for (const runtime of [first, second]) {
      expect(
        runtime.assembly.portImplementations.find((item) => item.port === alertsPort)?.impl,
      ).toBe(runtime.assembly.port(alertsPort));
      await alertsOf(runtime.assembly).raise(input);
    }
    await first.close();
    await alertsOf(first.assembly).raise(input);
    await alertsOf(second.assembly).raise(input);
    expect(await (await db.prisma()).alertEvent.findFirstOrThrow()).toMatchObject({
      occurrences: 1,
    });
    expect(await (await peer.prisma()).alertEvent.findFirstOrThrow()).toMatchObject({
      occurrences: 2,
    });
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
}, 60_000);

it("真实worker工厂告警公口落库，关闭该writer后不再写入", async () => {
  const prisma = await db.prisma();
  const clock = createClock(new Date("2026-10-09T04:00:00Z"));
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock }),
    channel: { enqueue: () => Promise.reject(new Error("用例不入队")), downForMs: () => 0 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const input = {
    rule: "evidence.consent_digest_unavailable",
    severity: "P2" as const,
    detail: { rows: 1 },
  };
  try {
    expect(worker.assembly.portImplementations.find((item) => item.port === alertsPort)?.impl).toBe(
      worker.assembly.port(alertsPort),
    );
    await alertsOf(worker.assembly).raise(input);
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      rule: input.rule,
      severity: "P2",
      occurrences: 1,
      kind: "event",
    });
    expect(worker.closeAlertFacts).toBeTypeOf("function");
    await worker.closeAlertFacts?.();
    await alertsOf(worker.assembly).raise(input);
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({ occurrences: 1 });
  } finally {
    await closeWorker(worker);
  }
}, 60_000);

it("worker保留调用方显式注入的告警端口，不用默认事实writer覆盖它", async () => {
  const prisma = await db.prisma();
  const clock = createClock(new Date("2026-10-09T04:00:00Z"));
  const recording = createRecordingPorts();
  const base = assembleForTest({ entry: "worker", extra: [recording.registration] });
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly: base,
    providers: createFakeProviders({ clock }),
    channel: { enqueue: () => Promise.reject(new Error("用例不入队")), downForMs: () => 0 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const input = {
    rule: "billing.advance_failed",
    severity: "P1" as const,
    detail: { attempts: 1 },
  };
  try {
    expect(worker.assembly.port(alertsPort)).toBe(base.port(alertsPort));
    await alertsOf(worker.assembly).raise(input);
    expect(recording.alerts).toEqual([input]);
    expect(await prisma.alertEvent.count()).toBe(0);
    await worker.closeAlertFacts?.();
    await alertsOf(worker.assembly).raise(input);
    expect(recording.alerts).toEqual([input, input]);
  } finally {
    await closeWorker(worker);
  }
}, 60_000);
