#!/usr/bin/env node
// natural 幂等的约束名核对（W0-10；约定 C47：x-idempotent: natural 必须写约束名数组，CI 逐个核对约束存在）。
// 这类路由不登记幂等键，靠库里的唯一约束去重；约束改了名、被删了，重复请求就不再被拦，而契约上看不出来。
// 这里拿路由清单里每条 natural 路由写的每个约束名，到跑完全部迁移的库里找：唯一约束、主键、排他约束或唯一索引。
//
// 用法（在仓库根目录）：
//   node infra/ci/natural-constraints.mjs [--routes <文件>] [--database <库名>]
//   --routes    路由清单，缺省 packages/contract/generated/routes.json
//   --database  缺省 lyx_migrate_check（空库跑完全部迁移的那个库，建法见 packages/db/README.md 第 3 节）；只读
// 连库：DATABASE_URL 或 PG* 环境变量（取主机、端口、账号；本地的取值见 CLAUDE.md 第 9 节）。不打印连接串。
// 退出码：0 通过；1 有约束名在库里找不到，或有 natural 路由没写约束名；2 用法或环境错误（连不上、库没跑过迁移）。
// 本脚本不引依赖。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pgEnv, psql } from "./db-lib.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

/** 库里能承担去重的名字：唯一约束、主键、排他约束，加上唯一索引（部分唯一索引没有对应的约束） */
const NAMES_SQL = `
select c.conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace
 where n.nspname = 'public' and c.contype in ('u', 'p', 'x')
union
select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and i.indisunique;
`;

function fail(message) {
  console.error(`约束名核对：没跑成。${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    routes: "packages/contract/generated/routes.json",
    database: "lyx_migrate_check",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : "";
    if (!(name in options)) fail(`不认识的参数 ${argv[index]}`);
    if (argv[index + 1] === undefined) fail(`${argv[index]} 后面要跟一个值`);
    options[name] = argv[index + 1];
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
let routes;
try {
  routes = JSON.parse(readFileSync(resolve(repoRoot, options.routes), "utf8"));
} catch {
  fail(`读不了路由清单 ${options.routes}，或它不是合法的 JSON`);
}
let env;
try {
  env = pgEnv();
} catch (error) {
  fail(error.message);
}
const result = psql(options.database, NAMES_SQL, env);
if (result.status !== 0) fail(`库 ${options.database} 上的查询没跑成：${result.stderr.trim()}`);
const known = new Set(result.stdout.split("\n").filter(Boolean));
if (known.size === 0) fail(`库 ${options.database} 里一个唯一约束都没有：它跑过迁移吗`);

const natural = routes.filter((route) => route.xIdempotent === "natural");
const problems = [];
let checked = 0;
for (const route of natural) {
  const names = Array.isArray(route.idempotentBy) ? route.idempotentBy : [];
  if (names.length === 0) problems.push(`${route.operationId} 是 natural，却没有写约束名`);
  for (const name of names) {
    checked += 1;
    if (!known.has(name)) {
      problems.push(
        `${route.operationId} 写的约束 ${name} 在库 ${options.database} 里找不到（唯一约束或唯一索引）`,
      );
    }
  }
}
if (problems.length > 0) {
  console.error(`约束名核对未通过：\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `约束名核对通过：natural 路由 ${natural.length} 条，写了 ${checked} 处约束名，在库 ${options.database} 里都找得到。`,
);
