// pnpm --filter @liyoxi/services exec tsx scripts/seed-regions.ts [--province=510000] [--apply]
// 默认仅预览；写入仅允许本机 local/test，不读取密钥、不更新已有项。
import { parseArgs } from "node:util";
import { createPrismaClient } from "@liyoxi/db";
import { Redis } from "ioredis";
import {
  createConfigCache,
  localRegionSeeds,
  LOCAL_REGION_SOURCE,
  seedLocalRegions,
} from "../src/config/index.js";
import { createTxRunner, loadEnv, systemClock } from "../src/kernel/index.js";

const loopback = (value: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
async function main() {
  const { values } = parseArgs({
    options: { apply: { type: "boolean", default: false }, province: { type: "string" } },
  });
  const rows = localRegionSeeds(values.province);
  console.log(
    `地区快照：${LOCAL_REGION_SOURCE.year} 年；${rows.length} 项；仅本地调试开通有完整三级链的地区`,
  );
  console.log(
    `省 ${rows.filter((row) => row.ext.level === 1).length}，市/分组 ${rows.filter((row) => row.ext.level === 2).length}，区县 ${rows.filter((row) => row.ext.level === 3).length}；缺下级不可选 ${
      rows
        .filter((row) => !row.ext.opened)
        .map((row) => row.name)
        .join("、") || "无"
    }`,
  );
  if (!values.apply) {
    console.log("仅预览，未连接或写入数据库；加 --apply 导入");
    return;
  }
  const env = loadEnv({
    APP_ENV: process.env.APP_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
  });
  if (
    (env.APP_ENV !== "local" && env.APP_ENV !== "test") ||
    !loopback(env.DATABASE_URL) ||
    !loopback(env.REDIS_URL)
  )
    throw new Error("仅允许本机 local/test 数据库与 Redis");
  if (
    env.APP_ENV === "test" &&
    !new URL(env.DATABASE_URL).pathname.slice(1).startsWith("lyx_test_")
  )
    throw new Error("test 环境必须使用隔离测试库");
  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, max: 2 });
  const redis = new Redis(env.REDIS_URL, {
    keyPrefix: `lyx:${env.APP_ENV}:`,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  try {
    const tx = createTxRunner({ prisma, appEnv: env.APP_ENV });
    const result = await tx.run((handle) =>
      seedLocalRegions(handle, env.APP_ENV, systemClock.now(), values.province),
    );
    // 事务提交后刷新跨进程缓存；重跑也刷新，以便恢复上次 Redis 故障。
    let notified = true;
    await createConfigCache({
      clock: systemClock,
      redis,
      report: () => {
        notified = false;
      },
    }).bump("dict");
    console.log(
      `导入完成：新增 ${result.inserted}，已有 ${result.existing}（保留原名称、启停与开通配置）。`,
    );
    if (notified) console.log("字典缓存已通知刷新；退出基础信息后重新进入。");
    else
      console.warn(
        "数据已提交，但缓存通知失败；请恢复 Redis 后重跑本命令，或重启本地 API，再重新进入基础信息。",
      );
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}
main().catch((error: unknown) => {
  // 驱动报错可能带连接参数，失败仅输出固定说明与错误类型。
  console.error(
    `地区导入失败（${error instanceof Error ? error.name : "unknown"}）：请核对本机连接、基础种子及既有地区层级`,
  );
  process.exitCode = 2;
});
