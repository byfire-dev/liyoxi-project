// W1-21 无 Vitest 支架；仅新建本轮测试库或受保护 attach，不接受任意远程库。
import { randomBytes } from "node:crypto";
import { createPrismaClient } from "@liyoxi/db";
import {
  assertTestDatabaseUrl,
  dropTestDatabase,
  listTestDatabases,
  testDatabaseName,
  testDatabaseUrl,
} from "@liyoxi/db/testing/standalone";
import { Redis } from "ioredis";
import { createNotices } from "../config/index.js";
import { runDemoSeed } from "../demo-seed.js";
import { createLogger } from "../logger.js";
import { MEDIA_LOCAL_CONCURRENCY } from "../media/index.js";
import { createLocalWechat } from "../providers/index.js";
import {
  assertM1SharedScope,
  createM1HttpStorage,
  createM1RealClock,
  waitM1Due,
} from "./m1-shared.js";
import { runInvariants } from "../ops/index.js";
import { createRuntime } from "../runtime.js";
import { loadKeyring } from "../security/index.js";
import { loadEnv } from "../kernel/index.js";
import { createClock } from "./clock.js";
import { createProviderHarness } from "./data/provider-harness.js";
import { createSeededDatabase } from "./data/seeded-db.js";
import { fakeKeyEnv } from "./m1-fake-keys.js";
import { createCodecDemoMasterPreparer } from "./demo-masters.js";
import { installM1KnownMedia, m1Video } from "./m1-media.js";
import { M1_PROFILE_DEFAULTS, seedM1ProfileDefaults } from "./m1-profile-defaults.js";
import { readM1State } from "./m1-state.js";
import { m1Transport } from "./m1-transport.js";
import { m1WorkerObserver, waitM1Worker } from "./m1-observe.js";
import { completeWithQueuedPromote } from "./m1-upload.js";
import { M1_LOCAL_WECHAT } from "./m1-wechat.js";
import { createDeliveryProductionTools } from "./delivery-production-tools.js";
import {
  m1ProductionVideo,
  createM1ProductionMasterPreparer,
  finishM1Production,
} from "./m1-production.js";
import type { M1Support, M1SupportOptions } from "./m1-types.js";
import { assertM1OwnerNetwork } from "./m1-owner-network.js";

const localUrl = (
  url: string,
  protocols: readonly string[],
  hosts = ["127.0.0.1", "localhost"],
) => {
  const parsed = new URL(url);
  if (!protocols.includes(parsed.protocol) || !hosts.includes(parsed.hostname))
    throw new Error("M1 演示只接受本地测试 PostgreSQL/Redis");
};
export async function createM1Support(options: M1SupportOptions = {}): Promise<M1Support> {
  options.signal?.throwIfAborted();
  const attach = options.attach;
  if (options.wechatPay && (attach || options.ownerNetwork || process.env.APP_ENV !== "test"))
    throw new Error("M1 假支付身份仅接受本机test独立scope");
  const ownerNetwork = options.ownerNetwork !== undefined;
  if (ownerNetwork) assertM1OwnerNetwork(options, process.env);
  const diagnosticWrite = options.diagnosticWrite;
  const destination = diagnosticWrite ? { write: diagnosticWrite } : undefined;
  if (options.backgroundWorker && !attach) throw new Error("M1 后台worker模式只接受受保护attach");
  if (attach) {
    assertM1SharedScope(attach.scope);
    if (
      process.env.APP_ENV !== "local" ||
      options.clock ||
      !/^[a-z0-9]{1,12}$/.test(attach.chainId) ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(attach.version)
    )
      throw new Error("M1 attach 必须显式local/独立链标识/对应版本，且禁止可拨时钟");
  } else if (process.env.APP_ENV !== "test")
    throw new Error("M1 接口重放仅在 APP_ENV=test 的新隔离库执行");
  const base = loadEnv({
    APP_ENV: attach ? "local" : "test",
    LOG_LEVEL: "warn",
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
  });
  const isolationId = attach?.scope.runId ?? options.runId ?? randomBytes(6).toString("hex");
  if (!ownerNetwork) {
    localUrl(
      base.DATABASE_URL,
      ["postgres:", "postgresql:"],
      ["127.0.0.1", "localhost", ...(attach ? [`lyx-mixed-${isolationId}-postgres`] : [])],
    );
    localUrl(
      base.REDIS_URL,
      ["redis:"],
      ["127.0.0.1", "localhost", ...(attach ? [`lyx-mixed-${isolationId}-redis`] : [])],
    );
  }
  const runId = attach?.chainId ?? isolationId;
  if (!/^[a-z0-9]{1,12}$/.test(runId)) throw new Error("M1 runId 要 1–12 位小写字母数字");
  const databaseName = testDatabaseName("api", { session: isolationId, worker: "0", label: "m1" });
  const redisPrefix = `lyx:test:${isolationId}:0:`;
  const ownerToken = attach?.scope.ownerToken ?? randomBytes(16).toString("hex");
  const ownerKey = `${redisPrefix}m1.owner`;
  let redis: Redis | undefined;
  let ownRedisOwner = false;
  const clock = attach || ownerNetwork ? createM1RealClock() : (options.clock ?? createClock());
  // billing/demo-seed 的正式财务种子回溯 25h；只定义本轮历史，不拨动业务或自定义时钟。
  const startedAt = attach
    ? new Date(attach.scope.startedAt)
    : new Date(clock.now().getTime() - 25 * 3_600_000);
  let ownDatabase = false;
  let ownRedisScope = false;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let productionTools: ReturnType<typeof createDeliveryProductionTools> | undefined;
  let httpStorage: ReturnType<typeof createM1HttpStorage> | undefined;
  let workerRuntime: ReturnType<typeof createRuntime> | undefined;
  let db: ReturnType<typeof createPrismaClient> | undefined;
  let closed = false;
  let ownerClose: Promise<void> | undefined;
  const clearRedis = async () => {
    // SET 抛错或 NX 冲突都不证明归属；只断开本客户端，不清理其他轮次。
    const client = redis;
    if (!ownRedisOwner || !client) return;
    if ((await client.get(ownerKey)) !== ownerToken)
      throw new Error("M1 Redis scope 归属已改变，拒绝清理");
    if (!ownRedisScope) {
      await client.unlink(ownerKey);
      return;
    }
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", `${redisPrefix}*`, "COUNT", 500);
      cursor = next;
      const own = keys.filter((key) => key.startsWith(redisPrefix) && key !== ownerKey);
      if (own.length) await client.unlink(...own);
    } while (cursor !== "0");
    await client.unlink(ownerKey);
  };
  const closeResources = async () => {
    if (closed) return;
    closed = true;
    httpStorage?.abort();
    const errors: unknown[] = [];
    try {
      for (const action of [
        () => workerRuntime?.close(),
        () => runtime?.close(),
        () => productionTools?.tools.close(),
        () => httpStorage?.close(),
        () => db?.$disconnect(),
        async () => {
          if (ownDatabase) await dropTestDatabase(databaseName);
        },
        clearRedis,
        async () => {
          if (!ownerNetwork || !ownDatabase || !ownRedisScope) return;
          if ((await listTestDatabases({ session: isolationId })).includes(databaseName))
            throw new Error("M1 ownerNetwork 关闭后本轮数据库仍存在");
        },
        async () => {
          if (!ownerNetwork || !ownDatabase || !ownRedisScope || !redis) return;
          let cursor = "0";
          let remaining = 0;
          do {
            const [next, keys] = await redis.scan(cursor, "MATCH", `${redisPrefix}*`, "COUNT", 500);
            cursor = next;
            remaining += keys.filter((key) => key.startsWith(redisPrefix)).length;
          } while (cursor !== "0");
          if (remaining !== 0) throw new Error("M1 ownerNetwork 关闭后本轮 Redis scope 仍存在");
        },
      ]) {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      redis?.disconnect();
    }
    if (errors.length) throw new AggregateError(errors, "M1 本轮资源未完整清理");
  };
  const close = () => (ownerNetwork ? (ownerClose ??= closeResources()) : closeResources());
  try {
    redis = new Redis(base.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
    });
    // 错误由 connect/命令 Promise 传回；不让 ioredis 默认日志暴露连接信息。
    redis.on("error", () => undefined);
    await redis.connect();
    if (attach) {
      if ((await redis.get(ownerKey)) !== ownerToken)
        throw new Error("M1 attach 自有Redis能力已失效");
      if (!(await listTestDatabases({ session: isolationId })).includes(databaseName))
        throw new Error("M1 attach 自有数据库不存在；拒绝创建或重置");
    } else {
      if ((await redis.set(ownerKey, ownerToken, "NX")) !== "OK")
        throw new Error("M1 scope 已被另一轮使用，拒绝清理或覆盖");
      ownRedisOwner = true;
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${redisPrefix}*`, "COUNT", 500);
        cursor = next;
        if (keys.some((key) => key !== ownerKey))
          throw new Error("M1 Redis scope 已有数据，拒绝覆盖或清理上一轮");
      } while (cursor !== "0");
      if ((await listTestDatabases({ session: isolationId })).includes(databaseName))
        throw new Error("M1 测试库已经存在，拒绝重置上一轮的库");
      ownRedisScope = true;
      // 已取得独占的随机 scope；失败时也只收本轮刚创建的库。
      ownDatabase = true;
      await createSeededDatabase(databaseName, { clock });
    }
    const databaseUrl = testDatabaseUrl(databaseName);
    assertTestDatabaseUrl(databaseUrl);
    const env = {
      ...base,
      ...fakeKeyEnv(),
      DATABASE_URL: databaseUrl,
      ...(attach ? { WECHAT: M1_LOCAL_WECHAT } : {}),
      ...(options.wechatPay
        ? {
            WECHAT_PAY: {
              ...options.wechatPay,
              merchantSerialNo: "01",
              merchantPrivateKeyPem: "explicit-test-provider",
              apiV3Key: "00000000000000000000000000000000",
              publicKeyId: "PUB_KEY_ID_TEST",
              publicKeyPem: "explicit-test-provider",
              notifyUrl: "https://example.invalid/hooks/wechatpay",
            },
          }
        : {}),
    };
    const { providers } = createProviderHarness({ clock });
    options.prepareProviders?.(providers);
    providers.storage.capabilities.sts = false;
    const modelBudgetTransport = await options.modelBudgetTransport?.({
      redis,
      clock,
      redisPrefix,
    });
    const productionInput = await m1ProductionVideo();
    if (attach) httpStorage = createM1HttpStorage(attach);
    const boundProviders =
      httpStorage && attach
        ? {
            ...providers,
            storage: {
              ...httpStorage.storage,
              uploadLocation: {
                region: attach.storage.region,
                buckets: attach.storage.buckets,
              },
            },
            wechat: createLocalWechat({
              logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
            }),
          }
        : providers;
    productionTools = createDeliveryProductionTools(
      providers,
      productionInput.report,
      httpStorage?.storage,
    );
    runtime = createRuntime({
      entry: "api",
      env: { ...env, MEDIA_PRODUCTION: productionTools.env },
      mediaProductionTools: productionTools.tools,
      version: attach?.version ?? "m1-test",
      clock,
      redisKeyPrefix: redisPrefix,
      rateLimitCommandTimeoutMs: 5000,
      providers: boundProviders,
      modelBudgetTransport,
      logger: createLogger({
        svc: "api",
        env: attach ? "local" : "test",
        level: "warn",
        version: attach?.version ?? "m1-test",
        ...(destination ? { destination } : {}),
      }),
    });
    if (attach && !options.backgroundWorker)
      workerRuntime = createRuntime({
        entry: "worker",
        env: { ...env, MEDIA_PRODUCTION: productionTools.env },
        mediaProductionTools: productionTools.tools,
        version: attach.version,
        clock,
        redisKeyPrefix: redisPrefix,
        providers: boundProviders,
        logger: createLogger({
          svc: "worker",
          env: "local",
          level: "warn",
          version: attach.version,
          ...(destination ? { destination } : {}),
        }),
      });
    const apiRuntime = runtime;
    const jobRuntime = workerRuntime ?? apiRuntime;
    db = createPrismaClient({ connectionString: databaseUrl, max: 3 });
    const readDb = db;
    const assertOwned = () => {
      options.signal?.throwIfAborted();
      if (
        closed ||
        apiRuntime.env.APP_ENV !== (attach ? "local" : "test") ||
        apiRuntime.env.DATABASE_URL !== databaseUrl ||
        databaseName !== testDatabaseName("api", { session: isolationId, worker: "0", label: "m1" })
      )
        throw new Error("M1 支架已关闭或本轮库归属不一致");
      assertTestDatabaseUrl(apiRuntime.env.DATABASE_URL);
    };
    const observer = options.backgroundWorker
      ? m1WorkerObserver(
          apiRuntime,
          assertOwned,
          options.signal,
          options.backgroundWorker.resumeTimerScan,
        )
      : undefined;
    const transport =
      observer ??
      m1Transport(jobRuntime, assertOwned, startedAt, attach ? { realTime: true } : undefined);
    const video = await m1Video();
    const runPromote: M1Support["promote"] = async (fileId) => {
      assertOwned();
      if (observer) return observer.promote(fileId);
      const job = await apiRuntime.tx.run((tx) =>
        tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${fileId}` } }),
      );
      if (
        job.subjectId !== fileId ||
        job.subjectType !== "file_object" ||
        job.kind !== "promote" ||
        job.state !== "queued"
      )
        throw new Error("M1 文件缺本轮待执行 promote");
      await jobRuntime.media.promote({ jobId: job.id });
      const file = await readDb.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      const bucket = file.bucket;
      if (bucket !== "secure" && bucket !== "asset" && bucket !== "media" && bucket !== "pub")
        throw new Error("M1 文件桶不合法");
      const exists = httpStorage
        ? await httpStorage.storage.head({ bucket, key: file.objectKey })
        : null;
      if (
        file.status !== "stored" ||
        (httpStorage
          ? !exists?.ok || !exists.value.exists
          : !providers.storage.objects.has(`${file.bucket}/${file.objectKey}`))
      )
        throw new Error("M1 文件实际入库未完成");
    };
    const promotions = new Map<string, Promise<void>>();
    // HTTP上传仍可四路并发；只把实际消费排到执行器原有的两个槽，避免饱和时run未认领即返回。
    const promotionSlots = Array.from({ length: MEDIA_LOCAL_CONCURRENCY }, () => Promise.resolve());
    let nextPromotionSlot = 0;
    const promote: M1Support["promote"] = (fileId) => {
      // 没有常驻worker的本地支架与attach共用单次消费；complete后的显式promote可安全重入。
      if (observer) return runPromote(fileId);
      assertOwned();
      const existing = promotions.get(fileId);
      if (existing) return existing;
      const slot = nextPromotionSlot;
      nextPromotionSlot = (nextPromotionSlot + 1) % promotionSlots.length;
      const pending = promotionSlots[slot]!.then(() => runPromote(fileId));
      promotionSlots[slot] = pending.catch(() => undefined);
      promotions.set(fileId, pending);
      return pending;
    };
    const completeWithPromote = <T>(fileId: string, complete: () => Promise<T>): Promise<T> => {
      assertOwned();
      return completeWithQueuedPromote({
        complete,
        promote: async (signal) => {
          await waitM1Worker(
            async () => {
              const job = await apiRuntime.tx.run((tx) =>
                tx.mediaJob.findUnique({ where: { dedupeKey: `promote:${fileId}` } }),
              );
              if (promotions.has(fileId)) return fileId;
              if (!job) return null;
              if (
                job.subjectId !== fileId ||
                job.subjectType !== "file_object" ||
                job.kind !== "promote" ||
                job.state !== "queued"
              )
                throw new Error("M1 complete 未提供本轮 queued promote");
              return job.id;
            },
            assertOwned,
            signal,
          );
          signal.throwIfAborted();
          await promote(fileId);
        },
        cancel: () => jobRuntime.media.jobs.pause(),
        signal: options.signal,
      });
    };
    return {
      runId,
      databaseName,
      redisPrefix,
      runtime: apiRuntime,
      clock,
      providers,
      ...(httpStorage
        ? { httpIO: { upload: httpStorage.upload, readSigned: httpStorage.readSigned } }
        : {}),
      video,
      productionVideo: productionInput.video,
      profileDefaults: M1_PROFILE_DEFAULTS,
      async seedDemo() {
        assertOwned();
        if ((await apiRuntime.config.params.get("order.start_delay_minutes")) !== 0)
          throw new Error("M1 演示要求当前开工延迟为 0；拒绝覆盖已有参数");
        // Match the official demo CLI's one seed instant; HTTP/jobs keep their real runtime clock.
        const seededAtMs = attach ? clock.now().getTime() : undefined;
        const seedClock = seededAtMs === undefined ? clock : { now: () => new Date(seededAtMs) };
        const report = await runDemoSeed({
          ...apiRuntime,
          clock: seedClock,
          keyring: loadKeyring(env),
          appEnv: attach ? "local" : "test",
          billing: { assembly: apiRuntime.assembly, bizNo: apiRuntime.bizNo },
          notices: createNotices({ clock: seedClock, events: apiRuntime.events }),
          prepareMasters: createM1ProductionMasterPreparer(
            apiRuntime,
            providers,
            productionInput.video,
            attach ? undefined : createCodecDemoMasterPreparer({ ...apiRuntime, appEnv: "test" }),
            httpStorage,
            observer?.waitForBatch,
          ),
          params: apiRuntime.config.params,
        });
        const baseline = await seedM1ProfileDefaults(apiRuntime);
        return {
          ...report,
          inserted: report.inserted + baseline.inserted,
          tables: [...report.tables, { ...baseline, step: "m1-profile-baseline" }],
        };
      },
      async checklist(code) {
        assertOwned();
        const template = await apiRuntime.config.checklists.active(code);
        if (!template) throw new Error(`M1 缺少生效清单 ${code}`);
        return template;
      },
      readState(ids) {
        assertOwned();
        return readM1State(readDb, ids);
      },
      async readStaffTotpStep(staffId) {
        assertOwned();
        const row = await readDb.staff.findUniqueOrThrow({
          where: { id: staffId },
          select: { totpLastStep: true },
        });
        assertOwned();
        return row.totpLastStep;
      },
      ...transport,
      promote,
      ...(!observer ? { completeWithPromote } : {}),
      installKnownMedia(fileId, scope) {
        assertOwned();
        if (attach) throw new Error("M1 HTTP 模式不接手手填技术事实");
        return installM1KnownMedia(apiRuntime, providers, runId, fileId, scope);
      },
      finishProduction(fileId, scope) {
        assertOwned();
        if (observer) return observer.finishProduction(fileId, scope);
        return finishM1Production(
          jobRuntime,
          providers,
          clock,
          productionInput.video,
          fileId,
          scope,
          () => transport.drainEvents(),
          httpStorage ? { storage: httpStorage.storage, waitUntil: waitM1Due } : undefined,
        );
      },
      async fullInvariants() {
        assertOwned();
        const report = await runInvariants(apiRuntime, { mode: "full", trigger: "manual" });
        if (report.violationsFound > 0) {
          const rows = await readDb.invariantViolation.groupBy({
            by: ["code", "subjectType"],
            where: { invariantRunId: report.runId },
            _count: { _all: true },
            orderBy: [{ code: "asc" }, { subjectType: "asc" }],
            take: 100,
          });
          const line = `M1 全域失败摘要：${JSON.stringify({
            checksRun: report.checksRun,
            errors: report.errors.length,
            counts: rows.map((row) => ({
              code: row.code,
              subjectType: row.subjectType,
              count: row._count._all,
            })),
          })}\n`;
          if (diagnosticWrite) diagnosticWrite(line);
          else process.stdout.write(line);
        }
        return report;
      },
      sharedScope() {
        assertOwned();
        return {
          runId: isolationId,
          databaseName,
          redisPrefix,
          ownerToken,
          startedAt: startedAt.toISOString(),
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
