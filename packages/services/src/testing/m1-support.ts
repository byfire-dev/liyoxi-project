// W1-21 无 Vitest 支架；仅新建本轮测试库，不接受 stack/prod/远程库。
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
import { createDeliveryProductionTools } from "./delivery-production-tools.js";
import {
  m1ProductionVideo,
  createM1ProductionMasterPreparer,
  finishM1Production,
} from "./m1-production.js";
import type { M1Support, M1SupportOptions } from "./m1-types.js";

const localUrl = (url: string, protocols: readonly string[]) => {
  const parsed = new URL(url);
  if (!protocols.includes(parsed.protocol) || !["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("M1 演示只接受本地测试 PostgreSQL/Redis");
};
export async function createM1Support(options: M1SupportOptions = {}): Promise<M1Support> {
  if (process.env.APP_ENV !== "test")
    throw new Error("M1 接口重放仅在 APP_ENV=test 的新隔离库执行");
  const base = loadEnv({
    APP_ENV: "test",
    LOG_LEVEL: "warn",
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
  });
  localUrl(base.DATABASE_URL, ["postgres:", "postgresql:"]);
  localUrl(base.REDIS_URL, ["redis:"]);
  const runId = options.runId ?? randomBytes(6).toString("hex");
  if (!/^[a-z0-9]{1,12}$/.test(runId)) throw new Error("M1 runId 要 1–12 位小写字母数字");
  const databaseName = testDatabaseName("api", { session: runId, worker: "0", label: "m1" });
  const redisPrefix = `lyx:test:${runId}:0:`;
  const ownerToken = randomBytes(16).toString("hex");
  const ownerKey = `${redisPrefix}m1.owner`;
  let redis: Redis | undefined;
  let ownRedisOwner = false;
  const clock = options.clock ?? createClock();
  // billing/demo-seed 的正式财务种子回溯 25h；只定义本轮历史，不拨动业务或自定义时钟。
  const startedAt = new Date(clock.now().getTime() - 25 * 3_600_000);
  let ownDatabase = false;
  let ownRedisScope = false;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let productionTools: ReturnType<typeof createDeliveryProductionTools> | undefined;
  let db: ReturnType<typeof createPrismaClient> | undefined;
  let closed = false;
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
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    try {
      for (const action of [
        () => runtime?.close(),
        () => productionTools?.tools.close(),
        () => db?.$disconnect(),
        async () => {
          if (ownDatabase) await dropTestDatabase(databaseName);
        },
        clearRedis,
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
  try {
    redis = new Redis(base.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
    });
    // 错误由 connect/命令 Promise 传回；不让 ioredis 默认日志暴露连接信息。
    redis.on("error", () => undefined);
    await redis.connect();
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
    if ((await listTestDatabases({ session: runId })).includes(databaseName))
      throw new Error("M1 测试库已经存在，拒绝重置上一轮的库");
    ownRedisScope = true;
    // 已取得独占的随机 scope；失败时也只收本轮刚创建的库。
    ownDatabase = true;
    await createSeededDatabase(databaseName, { clock });
    const databaseUrl = testDatabaseUrl(databaseName);
    assertTestDatabaseUrl(databaseUrl);
    const env = { ...base, ...fakeKeyEnv(), DATABASE_URL: databaseUrl };
    const { providers } = createProviderHarness({ clock });
    providers.storage.capabilities.sts = false;
    const productionInput = await m1ProductionVideo();
    productionTools = createDeliveryProductionTools(providers, productionInput.report);
    runtime = createRuntime({
      entry: "api",
      env: { ...env, MEDIA_PRODUCTION: productionTools.env },
      mediaProductionTools: productionTools.tools,
      version: "m1-test",
      clock,
      redisKeyPrefix: redisPrefix,
      rateLimitCommandTimeoutMs: 5000,
      providers,
      logger: createLogger({ svc: "api", env: "test", level: "warn", version: "m1-test" }),
    });
    const apiRuntime = runtime;
    db = createPrismaClient({ connectionString: databaseUrl, max: 3 });
    const readDb = db;
    const assertOwned = () => {
      if (
        closed ||
        apiRuntime.env.APP_ENV !== "test" ||
        apiRuntime.env.DATABASE_URL !== databaseUrl ||
        databaseName !== testDatabaseName("api", { session: runId, worker: "0", label: "m1" })
      )
        throw new Error("M1 支架已关闭或本轮库归属不一致");
      assertTestDatabaseUrl(apiRuntime.env.DATABASE_URL);
    };
    const transport = m1Transport(apiRuntime, assertOwned, startedAt);
    const video = await m1Video();
    return {
      runId,
      databaseName,
      redisPrefix,
      runtime: apiRuntime,
      clock,
      providers,
      video,
      productionVideo: productionInput.video,
      profileDefaults: M1_PROFILE_DEFAULTS,
      async seedDemo() {
        assertOwned();
        if ((await apiRuntime.config.params.get("order.start_delay_minutes")) !== 0)
          throw new Error("M1 演示要求当前开工延迟为 0；拒绝覆盖已有参数");
        const report = await runDemoSeed({
          ...apiRuntime,
          keyring: loadKeyring(env),
          appEnv: "test",
          billing: { assembly: apiRuntime.assembly, bizNo: apiRuntime.bizNo },
          notices: createNotices({ clock, events: apiRuntime.events }),
          prepareMasters: createM1ProductionMasterPreparer(
            apiRuntime,
            providers,
            productionInput.video,
            createCodecDemoMasterPreparer({ ...apiRuntime, appEnv: "test" }),
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
      ...transport,
      async promote(fileId) {
        assertOwned();
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
        await apiRuntime.media.promote({ jobId: job.id });
        const file = await readDb.fileObject.findUniqueOrThrow({ where: { id: fileId } });
        if (
          file.status !== "stored" ||
          !providers.storage.objects.has(`${file.bucket}/${file.objectKey}`)
        )
          throw new Error("M1 文件实际入库未完成");
      },
      installKnownMedia(fileId, scope) {
        assertOwned();
        return installM1KnownMedia(apiRuntime, providers, runId, fileId, scope);
      },
      finishProduction(fileId, scope) {
        assertOwned();
        return finishM1Production(
          apiRuntime,
          providers,
          clock,
          productionInput.video,
          fileId,
          scope,
          () => transport.drainEvents(),
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
          process.stdout.write(
            `M1 全域失败摘要：${JSON.stringify({
              checksRun: report.checksRun,
              errors: report.errors.length,
              counts: rows.map((row) => ({
                code: row.code,
                subjectType: row.subjectType,
                count: row._count._all,
              })),
            })}\n`,
          );
        }
        return report;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
