// 带种子的干净库，不带 Vitest 的那一半（W0-25）：播种、带种子的模板库、一轮测试之外建库。
// 命令行（scripts/seeded-db.ts）只引本文件；测试文件用 ./seeded.ts 的 useSeededDatabase。说明见 ./seeded.ts 开头。
import { createPrismaClient } from "@liyoxi/db";
import {
  createMigratedTestDatabase,
  ensureDerivedTemplate,
  testDatabaseName,
  testDatabaseUrl,
} from "@liyoxi/db/testing/standalone";

import { createTxRunner } from "../../kernel/index.js";
import type { Clock } from "../../kernel/index.js";
import { checkSeedAssertions, runSeed } from "../../seed.js";
import type { SeedReport } from "../../seed.js";
import { createClock } from "../clock.js";

/** 带种子的模板库的标签：库名 lyx_test_tpl_<会话标识>_seed */
export const SEEDED_TEMPLATE_LABEL = "seed";

/** 往一个跑完迁移的测试库里播种，再核对六条断言 */
async function seedTestDatabase(name: string, clock: Clock): Promise<SeedReport> {
  const prisma = createPrismaClient({ connectionString: testDatabaseUrl(name), max: 2 });
  try {
    const report = await runSeed({ tx: createTxRunner({ prisma, appEnv: "test" }), clock });
    const violations = await checkSeedAssertions(prisma, clock.now());
    if (violations.length > 0) {
      const lines = violations.map((item) => `${item.code} ${item.subjectKey}：${item.detail}`);
      throw new Error(`播种后有 ${violations.length} 条断言违规：\n${lines.join("\n")}`);
    }
    return report;
  } finally {
    await prisma.$disconnect();
  }
}

/** 要本轮的带种子的模板库：已经播好的直接用。返回库名 */
export function ensureSeededTemplate(): Promise<string> {
  return ensureDerivedTemplate(SEEDED_TEMPLATE_LABEL, async (name) => {
    await seedTestDatabase(name, createClock());
  });
}

/** createSeededDatabase 缺省的库名：lyx_test_services_<会话标识>_0_seeded */
export function defaultSeededDatabaseName(): string {
  return testDatabaseName("services", { worker: "0", label: "seeded" });
}

export interface CreateSeededDatabaseOptions {
  /** 播种的时刻取它；缺省是可拨时钟的缺省起点 */
  clock?: Clock;
}

export interface SeededDatabase {
  /** 库名（lyx_test_ 开头） */
  readonly name: string;
  readonly report: SeedReport;
}

/**
 * 建一个带种子的干净库，不靠模板库：一轮测试之外用（命令行、演示）。同名的库已存在即删掉重建。
 * 库名要过测试库的守卫（lyx_test_ 开头）；用完由调用方删，或 pnpm test:db:prune。
 */
export async function createSeededDatabase(
  name: string = defaultSeededDatabaseName(),
  options: CreateSeededDatabaseOptions = {},
): Promise<SeededDatabase> {
  await createMigratedTestDatabase(name);
  return { name, report: await seedTestDatabase(name, options.clock ?? createClock()) };
}
