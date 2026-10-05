#!/usr/bin/env node
// pnpm test:db:prune：清理测试库（W0-05b）。只删 lyx_test_ 开头的库，别的库一个不动。
//
// 用法：node packages/db/src/testing/prune.mjs [--session <会话标识> | --all] [--dry-run]
//   不带参数   删本会话留下的：会话标识取 LYX_TEST_SESSION，没设就取本检出根路径的短哈希
//   --session  删指定会话留下的
//   --all      删实例上全部 lyx_test_ 开头的库。别的会话的 infra 用例自己建的 lyx_test_infra_… 也在内，
//              别人正在跑测试时不要用
//   --dry-run  只列出要删的，不动手
// 所属的会话正有一轮测试在跑的库不删（会话锁被占着），列在“没删”里。
// 连接参数取环境变量 DATABASE_URL（CLAUDE.md 第 9 节）。退出码：0 正常；1 出错；2 用法错误。
//
// 守卫、删库都在 database.ts 里，这里用 Node 自带的类型擦除直接加载它，不另抄一份。

import { pruneTestDatabases, resolveTestSession } from "./database.ts";

function usage(message) {
  console.error(`test:db:prune：${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let scope;
let dryRun = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--all") scope = { all: true };
  else if (arg === "--session") {
    const session = args[(index += 1)];
    if (!session || !/^[a-z0-9]{1,12}$/.test(session))
      usage("--session 后面要跟会话标识（1–12 位小写字母与数字）");
    scope = { session };
  } else usage(`不认识的参数 ${arg}`);
}

try {
  scope ??= { session: resolveTestSession() };
  const plan = await pruneTestDatabases(scope, { dryRun });
  const where = "all" in scope ? "实例上全部测试库" : `会话 ${scope.session}`;
  const lines = [
    `test:db:prune（${where}）：${dryRun ? "要删" : "已删"} ${plan.drop.length} 个，没删 ${plan.skipped.length} 个`,
    ...plan.drop.map((name) => `  ${dryRun ? "要删" : "已删"} ${name}`),
    ...plan.skipped.map(({ name, reason }) => `  没删 ${name}（${reason}）`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  console.error(`test:db:prune：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
