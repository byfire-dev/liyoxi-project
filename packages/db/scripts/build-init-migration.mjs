#!/usr/bin/env node
// 拼首版迁移（W0-05 任务书 第 10 节第 3 步）。迁移文件是拼出来的，不手改。来源两处：
//   ① 从冻结的 docs/data-model/schema.prisma 出首版 DDL（离线，不连库）
//   ② docs/data-model/constraints/ 下的 00–15，按文件名顺序原样接在后面
// 语义一字不改，只加注释：文件头、每个来源前的分隔行、四类语句前各一行 “-- lyx:allow <理由>”
//（D7 第 8.3 节第 5 条：DROP、RENAME、ALTER … TYPE、不带默认值的 SET NOT NULL）。
//
// 用法：node scripts/build-init-migration.mjs [--check]
//   不带参数  重拼并写入 prisma/migrations/20261005000000_init/migration.sql
//   --check   重拼后与入库的文件逐字节比对：不同即退出码 1，不写文件
// 两种用法末尾都列出带 lyx:allow 的语句。不引依赖；Prisma 用本包装的那一份。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const constraintsDir = join(pkg, "../../docs/data-model/constraints");
const target = join(pkg, "prisma/migrations/20261005000000_init/migration.sql");

function fail(message) {
  console.error(`拼首版迁移：${message}`);
  process.exit(1);
}

/** 离线出建表语句。截取办法与 tools/schema-check/check.py 相同：从第一个 “--” 起，到升级提示框之前 */
function prismaDdl() {
  const result = spawnSync(
    join(pkg, "node_modules/.bin/prisma"),
    [
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema",
      join(pkg, "../../docs/data-model/schema.prisma"),
      "--script",
    ],
    {
      cwd: pkg,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // migrate diff 要配置里有连接串，但不会去连：给一个连不上的占位地址（.invalid 是保留域名），
      // 不管调用方的环境里有没有 DATABASE_URL，这一步都碰不到任何库。CHECKPOINT_DISABLE 关掉升级检查
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://offline.invalid/unused",
        CHECKPOINT_DISABLE: "1",
      },
    },
  );
  const start = result.stdout?.indexOf("--") ?? -1;
  if (result.status !== 0 || start < 0) {
    fail(`prisma migrate diff 没跑成：\n${result.stdout ?? ""}${result.stderr ?? result.error}`);
  }
  return result.stdout.slice(start).split("┌")[0];
}

const FOUR_KINDS =
  /\b(drop|rename)\b|\bset\s+not\s+null\b|\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/i;
const FRESH = "首版迁移，表刚建出来、没有数据";

/**
 * 一行语句属于四类之一时给出 [类别, 理由]，不属于给 null。
 * 认出是四类、却不是下面登记过的写法：报错，不让它悄悄漏标。
 */
function allowFor(line, where, columnsWithDefault) {
  if (line.trimStart().startsWith("--") || !FOUR_KINDS.test(line)) return null;
  if (line === "ALTER TABLE analytics_event RENAME TO analytics_event_plain;") {
    return ["RENAME", `${FRESH}：分区改造，Prisma 建出的表让出名字，作模板重建为按月分区的表`];
  }
  if (line === "DROP TABLE analytics_event_plain;") {
    return ["DROP", `${FRESH}：分区改造，按模板建出分区表之后删掉模板`];
  }
  const column = line.match(/^ALTER TABLE (\w+) ALTER COLUMN (\w+) SET NOT NULL;$/);
  if (column) {
    if (columnsWithDefault.has(`${column[1]}.${column[2]}`)) return null;
    return [
      "不带默认值的 SET NOT NULL",
      `${FRESH}：Prisma 把标量数组列建成可空，这里补非空；该列没有默认值`,
    ];
  }
  return fail(`${where} 里有一行属于要带 lyx:allow 的四类，但没有登记理由：${line}`);
}

function build() {
  const ddl = prismaDdl();
  if (!/^CREATE TABLE /m.test(ddl)) fail("prisma migrate diff 没有输出任何建表语句");
  // 建表语句里带默认值的列：给 SET NOT NULL 分“带不带默认值”用
  const columnsWithDefault = new Set();
  let table = null;
  for (const line of ddl.split("\n")) {
    table = line.match(/^CREATE TABLE "(\w+)" \($/)?.[1] ?? table;
    const column = line.match(/^ {4}"(\w+)" .*\bDEFAULT\b/)?.[1];
    if (table && column) columnsWithDefault.add(`${table}.${column}`);
  }

  const files = readdirSync(constraintsDir)
    .filter((name) => /^\d\d-.+\.sql$/.test(name))
    .sort();
  if (files.length !== 16)
    fail(`constraints/ 下应有 00–15 共 16 个文件，现在是 ${files.length} 个`);

  const allowed = [];
  const annotate = (text, where) =>
    text
      .split("\n")
      .flatMap((line) => {
        const allow = allowFor(line, where, columnsWithDefault);
        if (!allow) return [line];
        allowed.push({ kind: allow[0], where, line });
        return [`-- lyx:allow ${allow[1]}`, line];
      })
      .join("\n");

  const parts = [
    "-- 首版迁移（W0-05）：建全 166 张表与 00–15 的手写约束。本文件由 packages/db/scripts/build-init-migration.mjs 拼出，不手改。",
    "-- 来源：① prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script 的输出；",
    "--       ② docs/data-model/constraints/ 下的 00–15，按文件名顺序原样接在后面。",
    "-- 语义一字未改，只加了注释：本段、每个来源前的分隔行、四类语句前的 “-- lyx:allow <理由>”（D7 第 8.3 节第 5 条）。",
    "-- 核对：pnpm --filter @liyoxi/db migration:build --check（重拼的结果应与本文件逐字节相同）。",
    "",
    "-- ===== 来源 ①：schema.prisma 的建表语句 =====",
    annotate(ddl.trimEnd(), "建表语句"),
    "",
  ];
  for (const name of files) {
    const text = readFileSync(join(constraintsDir, name), "utf8");
    parts.push(`-- ===== 来源 ②：constraints/${name} =====`, annotate(text.trimEnd(), name), "");
  }
  return { sql: parts.join("\n"), allowed };
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.some((arg) => arg !== "--check")) fail(`不认识的参数 ${args.join(" ")}。用法见脚本开头`);
const { sql, allowed } = build();
const digest = createHash("sha256").update(sql).digest("hex");

if (args.includes("--check")) {
  const committed = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (committed !== sql) {
    const at = committed?.split("\n").findIndex((line, index) => line !== sql.split("\n")[index]);
    fail(
      committed === null
        ? "入库的迁移文件不存在"
        : `重拼的结果与入库的迁移不同（第 ${at + 1} 行起）。迁移不手改；底稿或 schema 变了要走结构变更包`,
    );
  }
  console.log(
    `重拼的结果与入库的迁移逐字节相同（${sql.split("\n").length - 1} 行，sha256 ${digest}）`,
  );
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, sql);
  console.log(`已写入 ${target}（${sql.split("\n").length - 1} 行，sha256 ${digest}）`);
}

const kinds = ["DROP", "RENAME", "ALTER … TYPE", "不带默认值的 SET NOT NULL"];
const counts = kinds.map(
  (kind) => `${kind} ${allowed.filter((item) => item.kind === kind).length}`,
);
console.log(`带 lyx:allow 的语句 ${allowed.length} 条：${counts.join("，")}`);
for (const item of allowed) console.log(`  [${item.kind}] ${item.where}：${item.line}`);
