/**
 * 一条命令得到带种子的干净库（W0-25）。根脚本：pnpm test:db:seeded。
 *
 * 用法（在仓库根目录，要本地的 PostgreSQL 在运行；DATABASE_URL 的取值见 CLAUDE.md 第 9 节）：
 *   DATABASE_URL=… pnpm test:db:seeded                    库名缺省 lyx_test_services_<会话标识>_0_seeded
 *   DATABASE_URL=… pnpm test:db:seeded --name lyx_test_demo
 *
 * 做什么：同名的库已存在即删掉；建库，跑全部迁移，跑 W0-21 的种子，核对六条断言；打印库名。
 * 只建 lyx_test_ 开头的库（过测试库的守卫）；主机与账号取 DATABASE_URL，库名换成上面那个。
 * 连它：把 DATABASE_URL 里的库名换掉；要应用角色的权限，连接串后面加 ?options=-c%20role%3Dlyx_app。
 * 用完清理：pnpm test:db:prune（缺省名的库属于本会话；--name 起的别的名字用 --all，或自己删）。
 * 退出码：0 建好；1 播种后断言有违规；2 参数、库名不对或连不上库。连接串与口令不打印。
 * 实现见 ../src/testing/data/seeded-db.ts；测试文件里要带种子的库用 useSeededDatabase，不用本命令。
 */
import { parseArgs } from "node:util";

import { createSeededDatabase, defaultSeededDatabaseName } from "../src/testing/data/seeded-db.js";

async function main(): Promise<number> {
  let name: string;
  try {
    const { values } = parseArgs({ options: { name: { type: "string" } }, strict: true });
    name = values.name ?? defaultSeededDatabaseName();
  } catch (error) {
    console.error(`test:db:seeded：${error instanceof Error ? error.message : String(error)}`);
    console.error("用法：pnpm test:db:seeded [--name <lyx_test_ 开头的库名>]");
    return 2;
  }
  let result;
  try {
    result = await createSeededDatabase(name);
  } catch (error) {
    // 只打印错误的类型与说明：连接串可能出现在驱动的报错对象里，不整个打印
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`test:db:seeded 没建成：${text}`);
    return text.includes("断言违规") ? 1 : 2;
  }
  console.log(`带种子的干净库：${result.name}`);
  console.log(`迁移已跑完；播种新增 ${result.report.inserted} 行；断言 0 条违规`);
  console.log("连它：把 DATABASE_URL 里的库名换成上面这个；清理：pnpm test:db:prune");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      `test:db:seeded 失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    process.exitCode = 2;
  },
);
