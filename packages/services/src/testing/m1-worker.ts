// Owned test IO/composition only; the application uses the actual worker runtime and lease keeper.
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { z } from "@liyoxi/contract";
import { QUEUES } from "@liyoxi/contract/registry";
import { listTestDatabases, testDatabaseUrl } from "@liyoxi/db/testing/standalone";
import { assembleServices } from "../assembly.js";
import { loadEnv, createQueueChannel } from "../kernel/index.js";
import { connectWorkerDatabase, connectProbeDatabase, createWorkerLease } from "../ops/index.js";
import type { WorkerServicesOptions } from "../ops/index.js";
import { SMS_TEMPLATE_PARAMS } from "../providers/index.js";
import { createProviderHarness } from "./data/provider-harness.js";
import { createDeliveryProductionTools } from "./delivery-production-tools.js";
import { fakeKeyEnv } from "./m1-fake-keys.js";
import { m1ProductionVideo } from "./m1-production.js";
import { assertM1SharedScope, createM1HttpStorage, createM1RealClock } from "./m1-shared.js";
import { readM1WorkerBacklog } from "./m1-observe.js";
import { createM1BackupIo } from "./m1-backup.js";

/** IPC input accepts public local fixture configuration only, never arbitrary provider URLs/keys. */
export const M1WorkerAttachmentSchema = z.strictObject({
  scope: z.strictObject({
    runId: z.string().regex(/^[a-z0-9]{1,12}$/),
    databaseName: z.string().max(63),
    redisPrefix: z.string().max(100),
    ownerToken: z.string().regex(/^[a-f0-9]{32}$/),
    startedAt: z.iso.datetime(),
  }),
  chainId: z.string().regex(/^[a-z0-9]{1,12}$/),
  version: z.string().regex(/^[a-f0-9]{40}$/),
  storage: z.strictObject({
    endpoint: z.string().max(200),
    publicEndpoint: z.string().max(200).optional(),
    region: z.string().min(1).max(64),
    accessKey: z.literal("liyoxi"),
    secretKey: z.literal("lyx-local-dev"),
    buckets: z.strictObject({
      secure: z.string(),
      asset: z.string(),
      media: z.string(),
      pub: z.string(),
    }),
  }),
});

export async function createM1WorkerResources(raw: unknown, workerQueues: readonly string[]) {
  const attach = M1WorkerAttachmentSchema.parse(raw);
  assertM1SharedScope(attach.scope);
  if (process.env.APP_ENV !== "local") throw new Error("M1 独立worker仅允许local自有attach");
  // The corresponding-source app supplies its actual consumers, not future registry queues.
  const queues = workerQueues.map((id) => {
    const registered = QUEUES.find((queue) => queue.id === id);
    if (!registered) throw new TypeError("M1 worker需要明确且已登记的实际消费者清单");
    return registered.id;
  });
  if (!queues.length || new Set(queues).size !== queues.length)
    throw new TypeError("M1 worker需要明确且已登记的实际消费者清单");
  const env = loadEnv({
    APP_ENV: "local",
    LOG_LEVEL: "warn",
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
  });
  for (const [value, protocols, service] of [
    [env.DATABASE_URL, ["postgres:", "postgresql:"], "postgres"],
    [env.REDIS_URL, ["redis:"], "redis"],
  ] as const) {
    const url = new URL(value);
    if (
      !protocols.some((protocol) => protocol === url.protocol) ||
      !["localhost", "127.0.0.1", `lyx-mixed-${attach.scope.runId}-${service}`].includes(
        url.hostname,
      )
    )
      throw new Error("M1 worker只接受本轮本地PostgreSQL/Redis");
  }
  const storage = createM1HttpStorage(attach); // validates all endpoints/physical buckets before IO
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => undefined);
  const clock = createM1RealClock();
  const backup = createM1BackupIo(attach.scope.runId, clock);
  let database: ReturnType<typeof connectWorkerDatabase> | undefined;
  let probe: ReturnType<typeof connectProbeDatabase> | undefined;
  let channel: ReturnType<typeof createQueueChannel> | undefined;
  let lease: ReturnType<typeof createWorkerLease> | undefined;
  let tools: ReturnType<typeof createDeliveryProductionTools> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const assertOwned = async () => {
    if (
      closed ||
      (await redis.get(`${attach.scope.redisPrefix}m1.owner`)) !== attach.scope.ownerToken
    )
      throw new Error("M1 独立worker自有能力已失效");
  };
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      const results = await Promise.allSettled([
        Promise.resolve().then(() => tools?.tools.close()),
        Promise.resolve().then(() => backup.close()),
        Promise.resolve().then(() => storage.close()),
        Promise.resolve().then(() => channel?.close()),
        Promise.resolve().then(() => lease?.close()),
        Promise.resolve().then(() => database?.close()),
        Promise.resolve().then(() => probe?.close()),
      ]);
      redis.disconnect();
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "M1 独立worker资源未完整关闭",
        );
    })());
  try {
    await redis.connect();
    await assertOwned();
    if (
      !(await listTestDatabases({ session: attach.scope.runId })).includes(
        attach.scope.databaseName,
      )
    )
      throw new Error("M1 worker自有库不存在，拒绝创建/重置");
    const databaseUrl = testDatabaseUrl(attach.scope.databaseName);
    database = connectWorkerDatabase(databaseUrl);
    probe = connectProbeDatabase(databaseUrl);
    channel = createQueueChannel({
      redisUrl: env.REDIS_URL,
      prefix: `${attach.scope.redisPrefix}bull`,
    });
    const holder = `mixed:${process.pid}:${randomUUID()}`;
    lease = createWorkerLease({ connectionString: databaseUrl, holder, version: attach.version });
    const { providers } = createProviderHarness({ clock });
    // Owned fixture configuration precedes worker start; the original direct sender still runs.
    const oncallPhone = "13800000000";
    const alertParams = SMS_TEMPLATE_PARAMS.ops_alert;
    if (!alertParams) throw new TypeError("M1 worker缺少正式运维短信字段定义");
    await database.prisma.smsTemplate.update({
      where: { templateKey: "ops_alert" },
      data: {
        status: "active",
        providerTemplateId: "900000001",
        signName: "本地测试",
        params: alertParams.map((field) => ({ ...field })),
        updatedAt: clock.now(),
      },
    });
    const input = await m1ProductionVideo();
    tools = createDeliveryProductionTools(providers, input.report, storage.storage);
    const boundProviders = {
      ...providers,
      storage: {
        ...storage.storage,
        ...backup.storage,
        uploadLocation: { region: attach.storage.region, buckets: attach.storage.buckets },
      },
    };
    const options: WorkerServicesOptions = {
      appEnv: "local",
      clock,
      prisma: database.prisma,
      sessionMutex: database.sessionMutex,
      assembly: assembleServices({ entry: "worker", appEnv: "local" }),
      channel,
      providers: boundProviders,
      mediaProductionTools: tools.tools,
      keys: {
        ...fakeKeyEnv(),
        MEDIA_PRODUCTION: tools.env,
        BACKUP: backup.config,
        ALERTS: { oncallPhones: [oncallPhone] },
      },
      backupProcessRunner: backup.processRunner,
      probe: { db: probe.prisma, holder: () => holder, queues },
    };
    const activeDatabase = database,
      activeChannel = channel,
      activeLease = lease;
    return {
      options,
      channel: activeChannel,
      lease: activeLease,
      close,
      assertOwned,
      async timerBarrierReady() {
        await assertOwned();
        const [orders, timers, queue] = await Promise.all([
          activeDatabase.prisma.dramaOrder.count({ where: { status: "pending_start" } }),
          activeDatabase.prisma.timer.count({
            where: { kind: "order.start", status: { in: ["scheduled", "dispatched"] } },
          }),
          activeChannel.observe!("timer_run", clock.now(), 100),
        ]);
        if (orders || timers) throw new Error("M1 timer屏障前已存在待开工目标");
        return queue.waiting === 0 && queue.active === 0 && queue.failed10Min === 0;
      },
      async snapshot() {
        await assertOwned();
        const backlog = await readM1WorkerBacklog(activeDatabase.prisma, clock.now());
        const row = await activeDatabase.prisma.workerLease.findUnique({
          where: { name: "primary" },
        });
        const observations = await Promise.all(
          queues.map(async (id) => ({
            name: id,
            ...(await activeChannel.observe!(id, clock.now(), 100)),
          })),
        );
        return {
          pid: process.pid,
          version: attach.version,
          lease: row
            ? {
                held: row.holder === holder,
                version: row.holderVersion,
                heartbeatAt: row.heartbeatAt.toISOString(),
                probeAt: row.probeAt?.toISOString() ?? null,
              }
            : null,
          backlog,
          backupIo: backup.snapshot(),
          alertSmsCalls: providers.sms.sent.filter(
            (message) =>
              message.kind === "subscribe_fallback" &&
              message.templateKey === "ops_alert" &&
              message.phone === oncallPhone,
          ).length,
          queues: observations,
        };
      },
    };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new Error("M1 worker装配及自有清理失败");
    }
    throw error;
  }
}

export type M1LoopWorkerSnapshot = Awaited<
  ReturnType<Awaited<ReturnType<typeof createM1WorkerResources>>["snapshot"]>
> & {
  active: boolean;
  errors: number;
  timerPaused: boolean;
  handled: { event: number; timer: number; media: number };
  cadence: {
    intervals: { outbox_relay: number; outbox_dispatch: number; timer_scan: number };
    domainIntervals: { media_job_run: number };
  };
};
