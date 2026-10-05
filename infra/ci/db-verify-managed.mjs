#!/usr/bin/env node
// 托管库验证（计划 第 8.6 节 V5“扩展”一项；W0-05 任务书 第 7 节第 9 条）：在托管 PostgreSQL 上确认
// 两个扩展可建、全部迁移跑得通、建出来的数量对得上。业主在自己的终端里跑，把输出回传。
//
// 用法：DATABASE_URL=<托管实例上一个 lyx_ 开头的空库> node infra/ci/db-verify-managed.mjs
//   根脚本是 pnpm db:verify-managed。本地演练：对本地实例上一个 lyx_ 开头的空库跑，做法见 packages/db/README.md
// 连接串只取环境变量 DATABASE_URL，不打印：输出里只有库名与服务器版本；迁移工具的输出只在失败时给出，
// 并先抹掉主机、端口、账号、口令。要本机有 psql，且已装依赖（pnpm install --frozen-lockfile）。
// 只动 DATABASE_URL 指的那一个库：库名不是 lyx_ 开头、或库里已经有表，一律拒绝。
// 退出码：0 通过；1 有一项没过；2 用法或环境错误。本脚本不引依赖。

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CATALOG_SQL, countReport, parseCatalog, pgEnv, psql } from "./db-lib.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const EXTENSIONS = ["btree_gist", "pg_trgm"];

function stop(code, message) {
  console.error(`托管库验证：${message}`);
  process.exit(code);
}

let env;
try {
  env = pgEnv(process.env, { database: true });
} catch (error) {
  stop(2, error.message);
}
const db = env.PGDATABASE;
if (!/^lyx_[a-z0-9_]{1,58}$/.test(db))
  stop(2, "DATABASE_URL 指的库名要以 lyx_ 开头：只在专门的空库上验证");

/**
 * 抹掉连接信息：连接串本身、“主机:端口”、主机、口令、账号（先抹长的；口令不论长短都抹，其余不足 3 个字符的不抹，
 * 免得把正文抹花），以及 psql 报错里括号中的解析地址（带点或冒号的才算，SqlState(…) 这类留着）与 “port <端口>”
 */
function redact(text) {
  const hostPort = `${env.PGHOST}:${env.PGPORT}`;
  const secrets = [process.env.DATABASE_URL, hostPort, env.PGPASSWORD, env.PGHOST, env.PGUSER]
    .filter((value) => value && (value === env.PGPASSWORD || value.length >= 3))
    .sort((a, b) => b.length - a.length);
  return secrets
    .reduce((out, value) => out.replaceAll(value, "‹已隐去›"), text)
    .replace(/\((?=[^)]*[.:])[0-9a-fA-F:.]{3,}\)/g, "(‹已隐去›)")
    .replace(/\bport \d+/g, "port ‹已隐去›");
}

/** 查一句，返回各行（竖线分隔的列） */
function query(sql) {
  const result = psql(db, sql, env);
  if (result.status !== 0) stop(2, `连不上库，或语句没跑成：${redact(result.stderr.trim())}`);
  return result.stdout.trim() === "" ? [] : result.stdout.trim().split("\n");
}

const problems = [];
const [version] = query("select current_setting('server_version')");
const tables = Number(
  query(
    "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r', 'p')",
  )[0],
);
if (tables > 0) stop(2, `库 ${db} 里已经有 ${tables} 张表：要一个空库（删掉重建，或换一个库名）`);
console.log(`# 托管库验证报告\n\n- 库：\`${db}\`（空库）；PostgreSQL ${version}`);
if (!version.startsWith("17.")) problems.push(`服务器是 PostgreSQL ${version}，目标是 17`);

const available = query(
  `select name || ' ' || default_version from pg_available_extensions where name in ('${EXTENSIONS.join("', '")}') order by name`,
);
console.log(`- 实例上可装的扩展：${available.join("、") || "一个都没有"}`);
for (const name of EXTENSIONS) {
  if (!available.some((line) => line.startsWith(`${name} `)))
    problems.push(`实例上没有扩展 ${name}`);
}

const deploy = spawnSync("pnpm", ["--filter", "@liyoxi/db", "migrate:deploy"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const applied =
  deploy.status === 0
    ? query(
        "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by started_at",
      )
    : [];
if (deploy.status !== 0 || applied.length === 0) {
  problems.push("迁移没跑通");
  console.log(
    `- 迁移：没跑通。迁移工具的输出（连接信息已抹掉）：\n\n${redact(`${deploy.stdout ?? ""}${deploy.stderr ?? deploy.error}`).trim()}\n`,
  );
} else {
  console.log(`- 迁移：跑通，已完成 ${applied.length} 个（${applied.join("、")}）`);
  const installed = query(
    `select extname || ' ' || extversion from pg_extension where extname in ('${EXTENSIONS.join("', '")}') order by extname`,
  );
  console.log(`- 迁移建出的扩展：${installed.join("、") || "一个都没有"}`);
  if (installed.length !== EXTENSIONS.length) problems.push("两个扩展没有都建出来");
  // 读系统目录也走 query：迁移之后连接断了时，报错同样先抹掉连接信息
  const counts = countReport([["这个库", parseCatalog(query(CATALOG_SQL).join("\n"))]]);
  console.log(`\n## 数量两组口径\n\n${counts.lines.join("\n")}`);
  problems.push(...counts.problems);
}

if (problems.length > 0) {
  console.log(`\n结论：不通过。${problems.join("；")}`);
  process.exit(1);
}
console.log("\n结论：通过。两个扩展可建，迁移跑通，数量对得上");
