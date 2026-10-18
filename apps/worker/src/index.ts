// 任务进程入口（W0-23）。启动与关停的骨架借自参考工程 apps/worker/src/index.ts（去掉业务任务与错误监控）。
//   node dist/index.js           起任务进程：装配 → 自检 → 抢租约，谁持有租约谁干活
//   node dist/index.js --check   只做装配与自检（不连 Redis、不抢租约），通过即以 0 退出
// 环境变量只经 loadEnv 读；缺必填项或写错：打印“键名: 原因”（不带任何值）后以 1 退出。
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Redis } from "ioredis";

import {
  assembleServices,
  buildWorkerServices,
  bullPrefix,
  connectWorkerDatabase,
  connectProbeDatabase,
  createQueueChannel,
  createWorkerLease,
  EnvError,
  loadEnv,
  setPortLogger,
  installServerErrorHandlers,
  drainServerErrors,
} from "@liyoxi/services";
import type { QueueChannel, WorkerLease, WorkerServices } from "@liyoxi/services";

import { createLogger } from "./log.js";
import { recurringTable } from "./recurring.js";
import { createWorkerRuntime, QUEUE_CONCURRENCY } from "./runtime.js";
import type { WorkerQueue } from "./runtime.js";

/** 构建时由 build.mjs 写入；没经构建直接跑时是 dev */
declare const __LYX_VERSION__: string | undefined;
const VERSION = typeof __LYX_VERSION__ === "string" ? __LYX_VERSION__ : "dev";

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: { check: { type: "boolean", default: false } },
  });
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  setPortLogger(logger);

  // 装配：登记有重名、缺实现，订阅者、定时器处理器、周期任务与契约对不上，都在这几行抛错
  const assembly = assembleServices({ entry: "worker", appEnv: env.APP_ENV });
  const database = connectWorkerDatabase(env.DATABASE_URL);
  const wechatClosers: Array<() => Promise<void>> = [];
  // 装配可能在services返回前失败，模型所有权须先由入口持有。
  const modelClosers: Array<() => Promise<void>> = [];
  let modelClosing: Promise<void> | undefined;
  const closeModelDrivers = () =>
    (modelClosing ??= Promise.allSettled(
      modelClosers.map((close) => Promise.resolve().then(close)),
    ).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }));
  const wechatRedis = env.WECHAT
    ? new Redis(env.REDIS_URL, {
        lazyConnect: true,
        keyPrefix: `lyx:${env.APP_ENV}:`,
        maxRetriesPerRequest: 1,
      })
    : undefined;
  wechatRedis?.on("error", () => logger.warn({ evt: "wechat.cache_down" }, "微信令牌缓存不可用"));
  let channel: QueueChannel | undefined;
  let budgetRedis: Redis | undefined;
  let lease: WorkerLease | undefined;
  let services: WorkerServices | undefined;
  let removeErrorHandlers: ReturnType<typeof installServerErrorHandlers> | undefined;
  let probeDatabase: ReturnType<typeof connectProbeDatabase> | undefined;
  const settle = (closes: readonly (() => unknown)[]) =>
    Promise.allSettled(closes.map((close) => Promise.resolve().then(close)));
  const closeBudgetRedis = async () => {
    try {
      if (budgetRedis?.status === "ready") await budgetRedis.quit();
    } finally {
      budgetRedis?.disconnect();
    }
  };
  const dispose = async () => {
    removeErrorHandlers?.();
    const mutexClosing = database.sessionMutex.close();
    void mutexClosing.catch(() => undefined);
    let failure: PromiseRejectedResult | undefined;
    const clean = async (closes: readonly (() => unknown)[]) => {
      const results = await settle(closes);
      failure ??= results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
    };
    await clean([() => services?.disableModelBudget?.()]);
    await clean([() => services?.closeAlertDispatcher?.()]);
    await clean([
      () => services?.closeProbes?.(),
      () => services?.closeCertificates?.(),
      () => services?.closeBackups?.(),
      () => services?.shutdownMediaJobs?.(),
      () => services?.closeDocs(),
      () => services?.documentConverter?.close(),
    ]);
    await clean([
      () => services?.closeApproval?.(),
      () => services?.closeInvitations?.(),
      () => services?.closeMediaJobs?.(),
      () => services?.closeMediaDrivers?.(),
      () => services?.closeStorageDrivers?.(),
      ...wechatClosers,
    ]);
    await clean([closeModelDrivers]);
    await clean([() => services?.closeModelBudget?.()]);
    await clean([closeBudgetRedis]);
    await clean([() => services?.closeAlertFacts?.(), () => services?.closeServerErrors?.()]);
    await clean([() => mutexClosing]);
    await clean([
      () => wechatRedis?.disconnect(),
      () => channel?.close(),
      () => lease?.close(),
      () => database.close(),
      () => probeDatabase?.close(),
    ]);
    return failure;
  };
  try {
    if (!values.check) {
      budgetRedis = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
        connectTimeout: 250,
        commandTimeout: 250,
      });
      budgetRedis.on("error", () =>
        logger.warn({ evt: "media.model_budget_redis_down" }, "预算连接不可用"),
      );
      channel = createQueueChannel({
        redisUrl: env.REDIS_URL,
        prefix: bullPrefix(env.APP_ENV),
        onError: (source, error) => logger.debug({ source, err: error }, "队列连接报错"),
      });
    }
    if (!values.check) probeDatabase = connectProbeDatabase(env.DATABASE_URL);
    services = buildWorkerServices({
      ...(!values.check
        ? { serverErrorSource: { release: VERSION, artifactRoot: new URL("./", import.meta.url) } }
        : {}),
      ...(probeDatabase
        ? {
            probe: {
              db: probeDatabase.prisma,
              holder: () => lease?.holder,
              queues: Object.keys(QUEUE_CONCURRENCY) as WorkerQueue[],
            },
          }
        : {}),
      modelDrivers: {
        registerClose: (close) => modelClosers.push(close),
        close: closeModelDrivers,
      },
      ...(budgetRedis
        ? {
            modelBudgetTransport: {
              eval(script, keys, argv) {
                const client = budgetRedis!;
                if (client.status === "wait") void client.connect().catch(() => undefined);
                if (client.status !== "ready") return Promise.reject(new Error("预算连接尚未就绪"));
                return client.eval(script, keys.length, ...keys, ...argv);
              },
            },
          }
        : {}),
      documentWorkerUrl: new URL("./document-converter.js", import.meta.url),
      appEnv: env.APP_ENV,
      prisma: database.prisma,
      sessionMutex: database.sessionMutex,
      assembly,
      channel: channel ?? {
        enqueue: () => Promise.reject(new Error("自检模式不入队")),
        downForMs: () => 0,
      },
      report: (violation) => logger.error({ err: violation }, "内核违规"),
      logger,
      keys: env,
      ...(env.WECHAT && wechatRedis
        ? {
            wechat: {
              config: env.WECHAT,
              transport: {
                redis: wechatRedis,
                prefix: `lyx:${env.APP_ENV}:`,
                now: () => new Date(),
                registerClose: (close: () => Promise<void>) => {
                  wechatClosers.push(close);
                },
              },
            },
          }
        : {}),
    });
    await services.selfCheck();
  } catch (error) {
    // 自检或装配失败也回收本进程创建的资源；没有启动消费者，不借其它进程的连接。
    services?.serverErrors?.capture(error, "process.start");
    await drainServerErrors(services?.serverErrors);
    await dispose();
    throw error;
  }
  const summary = {
    version: VERSION,
    env: env.APP_ENV,
    modules: assembly.modules.length,
    subscribers: assembly.subscribers.length,
    timerHandlers: assembly.timerHandlers.length,
    recurring: recurringTable(services).map((job) => job.kind),
  };
  if (channel === undefined) {
    logger.info(summary, "装配与自检通过");
    const failure = await dispose();
    if (failure) throw failure.reason;
    return;
  }
  const activeChannel = channel;
  const activeServices = services;
  if (services.serverErrors)
    removeErrorHandlers = installServerErrorHandlers({
      reporter: services.serverErrors,
      log: (error, kind) => logger.error({ evt: kind, err: error }, "worker 未捕获异常，退出"),
    });

  let runtime: ReturnType<typeof createWorkerRuntime>;
  try {
    lease = createWorkerLease({
      connectionString: env.DATABASE_URL,
      holder: `${hostname()}:${randomUUID()}`,
      version: VERSION,
    });
    runtime = createWorkerRuntime({ services, channel, lease, logger });
  } catch (error) {
    services.serverErrors?.capture(error, "process.start");
    await drainServerErrors(services.serverErrors);
    await dispose();
    throw error;
  }
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    removeErrorHandlers?.();
    logger.info({ signal }, "收到终止信号：停循环、收在途任务、让出租约");
    let failed = false;
    try {
      activeServices.disableModelBudget?.();
      const mutexClosing = database.sessionMutex.close();
      void mutexClosing.catch(() => undefined);
      await settle(wechatClosers);
      await runtime.stop();
      await mutexClosing;
    } catch (error) {
      failed = true;
      logger.error({ err: error }, "任务关停失败");
      activeServices.serverErrors?.capture(error, "process.close");
      await drainServerErrors(activeServices.serverErrors);
    } finally {
      // runtime已完成业务drain；同一缓存Promise也覆盖stop自身提前失败的兜底。
      await settle([() => activeServices.closeProbes?.()]);
      const modelsClosed = await settle([closeModelDrivers]);
      const closed = await settle([
        () => activeServices.closeServerErrors?.(),
        closeBudgetRedis,
        () => activeChannel.close(),
        () => lease?.close(),
        () => database.close(),
        () => probeDatabase?.close(),
        () => wechatRedis?.disconnect(),
      ]);
      failed ||= [...modelsClosed, ...closed].some((result) => result.status === "rejected");
    }
    process.exit(failed || removeErrorHandlers?.hasFailed() ? 1 : 0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  try {
    runtime.start();
  } catch (error) {
    activeServices.serverErrors?.capture(error, "process.start");
    await drainServerErrors(activeServices.serverErrors);
    await settle([() => runtime.stop()]);
    await dispose();
    throw error;
  }
  logger.info({ ...summary, holder: lease.holder }, "任务进程已启动，等租约");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  void main().catch((error: unknown) => {
    // EnvError 的 message 只有键名与原因，不带值
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(1);
  });
