// W1-02 真实浏览器验收的服务端 CLI 桥：前端脚本只启动命令，不导入服务端或数据库。
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createPrismaClient } from "@liyoxi/db";
import { assertTestDatabaseName, dropTestDatabase } from "@liyoxi/db/testing/standalone";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { createRuntime } from "../src/runtime.js";
import { createLogger } from "../src/logger.js";
import { loadEnv } from "../src/kernel/env.js";
import { loadKeyring } from "../src/security/index.js";
import { createFactories } from "../src/testing/data/factories/index.js";
import { sealerOf } from "../src/testing/data/seal.js";
import { createFakeProviders } from "../src/testing/providers/index.js";
import type { AdminLiveFixture } from "../src/testing/admin-live/context.js";

const fixturesDir = fileURLToPath(new URL("../src/testing/admin-live/", import.meta.url));
let stage = "arguments";
let fixture: string | null = null;

function errorCategory(error: unknown) {
  if (error instanceof ZodError) return "validation";
  if (!(error instanceof Error)) return "unknown";
  switch (error.name) {
    case "EnvError":
      return "configuration";
    case "AppError":
      return "application";
    case "KernelViolation":
      return "kernel";
    case "PrismaClientKnownRequestError":
    case "PrismaClientUnknownRequestError":
    case "PrismaClientInitializationError":
    case "PrismaClientValidationError":
    case "PrismaClientRustPanicError":
      return "database";
    case "TypeError":
      return "type";
    case "RangeError":
      return "range";
    default:
      return "error";
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      "test-redis-prefix": { type: "string" },
      cleanup: { type: "boolean", default: false },
    },
  });
  const name = values.name;
  assertTestDatabaseName(name);
  const prefix = values["test-redis-prefix"];
  if (
    process.env.APP_ENV !== "test" ||
    !prefix ||
    !/^lyx:test:admin_live_[a-z0-9]{1,32}:$/.test(prefix)
  )
    throw new Error("只接受 test 环境与本轮 admin_live 测试前缀");
  const runId = prefix.slice("lyx:test:admin_live_".length, -1);
  if (name !== `lyx_test_admin_live_${runId}`)
    throw new Error("测试库与 Redis 前缀必须使用同一本轮标识");
  stage = "configuration";
  const env = loadEnv();
  if (values.cleanup) {
    stage = "resource_cleanup";
    // 不用 runtime.keyPrefix，SCAN 得到原始全名；绝不 FLUSHDB 或按环境统一前缀清理。
    const results = await Promise.allSettled([
      (async () => {
        const redis = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        });
        redis.on("error", () => undefined);
        try {
          let cursor = "0";
          do {
            const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
            cursor = next;
            if (keys.length > 0) await redis.del(...keys);
          } while (cursor !== "0");
        } finally {
          redis.disconnect();
        }
      })(),
      dropTestDatabase(name),
    ]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("测试资源清理未全部完成");
    process.stdout.write(`${JSON.stringify({ cleaned: name })}\n`);
    return;
  }
  stage = "database_scope";
  if (decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1)) !== name)
    throw new Error("DATABASE_URL 必须指向 --name 指定的测试库");
  stage = "runtime_assembly";
  const version = "admin-live-fixtures";
  const logger = createLogger({
    svc: "api",
    env: "test",
    level: env.LOG_LEVEL,
    version,
    destination: process.stderr,
  });
  const runtime = createRuntime({
    entry: "api",
    env,
    version,
    redisKeyPrefix: prefix,
    logger,
    providers: createFakeProviders(),
  });
  stage = "database_client";
  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, max: 2 });
  try {
    stage = "fixture_factories";
    const make = createFactories({
      db: prisma,
      clock: runtime.clock,
      seal: sealerOf(loadKeyring(env)),
    });
    const data: Record<string, unknown> = {};
    stage = "fixture_discovery";
    for (const file of (await readdir(fixturesDir))
      .filter((file) => file.endsWith(".fixture.ts"))
      .sort()) {
      fixture = /^[a-z0-9][a-z0-9-]{0,80}\.fixture\.ts$/.test(file)
        ? file
        : "unrecognized.fixture.ts";
      stage = "fixture_import";
      const module = (await import(pathToFileURL(resolve(fixturesDir, file)).href)) as {
        default?: AdminLiveFixture;
      };
      stage = "fixture_registration";
      if (typeof module.default !== "function") throw new Error("造数登记文件须导出 default 函数");
      try {
        stage = "fixture_execute";
        data[file.slice(0, -".fixture.ts".length)] = await module.default({ runtime, make });
      } catch (error) {
        if (error instanceof ZodError)
          process.stderr.write(
            `${JSON.stringify({
              evt: "admin.live.fixture.invalid",
              fixture: file,
              issues: error.issues.slice(0, 12).map((issue) => ({
                code: issue.code,
                path: issue.path.slice(0, 8),
              })),
            })}\n`,
          );
        throw error;
      }
    }
    fixture = null;
    stage = "fixture_output";
    process.stdout.write(`${JSON.stringify({ fixtures: data })}\n`);
  } finally {
    const results = await Promise.allSettled([prisma.$disconnect(), runtime.close()]);
    if (results.some((result) => result.status === "rejected")) {
      process.stderr.write("admin:live:data 测试连接回收失败\n");
      process.exitCode = 1;
    }
  }
}
main().catch((error: unknown) => {
  // 不把配置值、连接串或密钥材料带到前端命令输出。
  process.stderr.write(
    `${JSON.stringify({ evt: "admin.live.data.failed", stage, fixture, errorCategory: errorCategory(error) })}\n`,
  );
  process.exitCode = 1;
});
