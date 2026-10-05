// 带种子的干净库（W0-25）：迁移 + W0-21 的种子（runSeed，不另抄数据）。
//
//   测试文件里：const db = useSeededDatabase("services");   用法与 useTestDatabase 相同，库里多了种子。
//   一轮测试之外：createSeededDatabase()，或命令 pnpm test:db:seeded（入口 scripts/seeded-db.ts）。
//
// 种子在一轮测试里只播一次：第一次用到时从迁移模板库拷一份、播种、关掉连接入口，成为“带种子的模板库”
// lyx_test_tpl_<会话标识>_seed（@liyoxi/db/testing 的派生模板库）；之后每个测试文件的库从它拷，只付一次拷库。
// 播种的时刻取可拨时钟的缺省起点（DEFAULT_CLOCK_START）：用例的时钟不往回拨，种子就都已生效。
// 播种用应用角色 lyx_app（它的授权就够）；播完跑六条断言，有违规即抛错。
import { useTestDatabase } from "@liyoxi/db/testing";
import type { TestDatabase, TestDatabaseOptions, TestPackage } from "@liyoxi/db/testing";

import { ensureSeededTemplate } from "./seeded-db.js";

export * from "./seeded-db.js";

/**
 * 给当前测试文件一个带种子的库：useTestDatabase 的全部用法照旧（首次取连接时建库、全过即删、失败留库、
 * reset 删库重建），只是库从带种子的模板库拷，重置之后种子也在。
 * 包的 vitest.config.ts 同样要挂 globalSetup。
 */
export function useSeededDatabase(
  pkg: TestPackage,
  options: Omit<TestDatabaseOptions, "template"> = {},
): TestDatabase {
  return useTestDatabase(pkg, { ...options, template: ensureSeededTemplate });
}
