/**
 * 播种的命令行入口（W0-21）。根脚本：pnpm db:seed。
 *
 * 用法（在仓库根目录，库要先跑完迁移：pnpm db:deploy）：
 *   APP_ENV=local DATABASE_URL=… REDIS_URL=… pnpm db:seed
 * 连接参数只经 loadEnv 读环境变量（本地的取值见 CLAUDE.md 第 9 节；stg、prod 下连接串只认 *_FILE）。
 * Redis 用不到，只是 loadEnv 要它在。按应用角色 lyx_app 的授权就够，不要求属主。
 *
 * 做什么：按模块把缺的初始行插进去（没有才插，已有的行不改），打印各表新增与已有的行数；
 * 再跑六条配置类不变量的断言（staff.I8、config.N9、N16、N17、N19、N20）。可以反复跑。
 * 退出码：0 播完且断言 0 违规；1 有违规；2 环境变量不对或连不上库。连接串与口令不打印。
 * 运行器与规矩见 ../src/seed.ts 开头的注释。
 */
import { createPrismaClient } from "@liyoxi/db";

import { createTxRunner, EnvError, loadEnv, systemClock } from "../src/kernel/index.js";
import { checkSeedAssertions, runSeed } from "../src/seed.js";

async function main(): Promise<number> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(`播种：${error.message}`);
    return 2;
  }
  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, max: 2 });
  try {
    const report = await runSeed({
      tx: createTxRunner({ prisma, appEnv: env.APP_ENV }),
      clock: systemClock,
    });
    for (const table of report.tables) {
      console.log(
        `${table.module.padEnd(8)} ${table.table.padEnd(22)} 新增 ${String(table.inserted).padStart(4)}  已有 ${String(table.existing).padStart(4)}`,
      );
    }
    console.log(`播种完成：新增 ${report.inserted} 行`);

    const violations = await checkSeedAssertions(prisma, systemClock.now());
    for (const item of violations) {
      console.error(`违规 ${item.code}  ${item.subjectKey}：${item.detail}`);
    }
    console.log(`断言：${violations.length} 条违规`);
    return violations.length === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // 只打印错误的类型与说明：连接串可能出现在驱动的报错对象里，不整个打印
    console.error(
      `播种失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    process.exitCode = 2;
  },
);
