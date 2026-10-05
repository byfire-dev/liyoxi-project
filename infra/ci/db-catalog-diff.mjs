#!/usr/bin/env node
// 系统目录比对（W0-05 任务书 第 7 节第 2、4、5 条）：证明“首版迁移建出来的库”与“由底稿建的参照库”结构相同。
//
// 用法：node infra/ci/db-catalog-diff.mjs [--ref <库>] [--target <库>] [--report <文件>]
//   根脚本是 pnpm db:catalog-diff。连库的办法见 db-lib.mjs 开头（psql；PG* 环境变量，或 DATABASE_URL）
//   --ref     参照库，默认 lyx_schema_check：python3 tools/schema-check/check.py --keep 建的
//   --target  迁移库，默认 lyx_migrate_check：空库上跑过 pnpm db:deploy 的
//   --report  报告写到哪，默认 packages/db/dist/catalog-diff/report.md（CI 把它作为产物上传）
// 四段，任何一段不过即退出码 1：
//   0. 两个库都在 PostgreSQL 17 上。
//   1. 两份 schema.prisma（底稿与 packages/db 里迁入的那份）去掉文件头注释与 generator 块后逐字节相同。
//   2. 两个库的系统目录逐项相同：表、列、约束定义、索引定义、触发器、函数体六类，外加序列、扩展、策略、注释等其余对象。
//      _prisma_migrations 不计。口径写在 db-lib.mjs 的查询前面，比什么、不比什么都列在那里。
//   3. 两个库的数量都等于 06 第 1 节的两组口径（只数逻辑表 / 含分区子表）。
// 两个库只读不写。分区子表的名字随建库时的月份变（按库的时钟、北京时间）：两个库要在同一个月里建，
// 跨月建的两个库会多报差异，不会漏报。差异多于 40 处时只列前 40 处，各类各有几处看表里的“差异”一列。
// 退出码：0 通过；1 有差异或数量不对；2 用法或环境错误（连不上、库不存在）。本脚本不引依赖。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CATEGORIES, countReport, diffRows, digestOf, readCatalog } from "./db-lib.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const MAX_SHOWN = 40;

function usage(message) {
  console.error(`系统目录比对：${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    ref: "lyx_schema_check",
    target: "lyx_migrate_check",
    report: "packages/db/dist/catalog-diff/report.md",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].startsWith("--") ? argv[index].slice(2) : "";
    if (!Object.hasOwn(options, name)) usage(`不认识的参数 ${argv[index]}。用法见脚本开头`);
    if (argv[index + 1] === undefined) usage(`${argv[index]} 后面要跟一个值`);
    options[name] = argv[index + 1];
  }
  for (const db of [options.ref, options.target]) {
    if (!/^lyx_[a-z0-9_]{1,58}$/.test(db)) usage(`${db} 不是 lyx_ 开头的校验库`);
  }
  return options;
}

/** 去掉文件头注释（generator 之前的 // 行）与 generator 块，剩下的就是模型 */
function modelsOf(path) {
  const text = readFileSync(join(repoRoot, path), "utf8");
  const head = text.match(/^(?:\/\/.*\n)*generator \w+ \{\n(?:.*\n)*?\}\n/);
  if (!head) usage(`${path} 的开头不是“文件头注释 + generator 块”`);
  return text.slice(head[0].length).split("\n");
}

function schemaProblems() {
  const draft = modelsOf("docs/data-model/schema.prisma");
  const moved = modelsOf("packages/db/prisma/schema.prisma");
  const length = Math.max(draft.length, moved.length);
  for (let index = 0; index < length; index += 1) {
    if (draft[index] === moved[index]) continue;
    const show = (line) => (line === undefined ? "（没有这一行）" : JSON.stringify(line));
    return [
      `模型部分第 ${index + 1} 行起不同：底稿 ${show(draft[index])}；迁入的 ${show(moved[index])}`,
    ];
  }
  return [];
}

const options = parseArgs(process.argv.slice(2));
let ref, target;
try {
  ref = readCatalog(options.ref);
  target = readCatalog(options.target);
} catch (error) {
  usage(`读不到系统目录。${error.message}`);
}

const body = [];
const failures = [];
function section(title, lines, problems) {
  body.push(`## ${title}`, "", ...lines, "");
  if (problems.length === 0) return;
  failures.push(`${title}：${problems.length} 处`);
  const rest =
    problems.length > MAX_SHOWN ? [`- ……共 ${problems.length} 处，只列前 ${MAX_SHOWN} 处`] : [];
  body.push("差异：", "", ...problems.slice(0, MAX_SHOWN).map((line) => `- ${line}`), ...rest, "");
}

section(
  "0. 环境",
  [
    `- 参照库 \`${options.ref}\`：PostgreSQL ${ref.version}`,
    `- 迁移库 \`${options.target}\`：PostgreSQL ${target.version}`,
  ],
  [ref.version, target.version].every((version) => version.startsWith("17."))
    ? []
    : ["两个库都要在 PostgreSQL 17 上"],
);

const schema = schemaProblems();
section(
  "1. schema 迁入不改模型",
  [
    `两份 schema.prisma 去掉文件头注释与 generator 块后：${schema.length === 0 ? "逐字节相同" : "不同"}`,
  ],
  schema,
);

const rows = [
  "| 类别 | 参照库 | 迁移库 | 差异 | 参照库摘要 | 迁移库摘要 |",
  "| --- | --- | --- | --- | --- | --- |",
];
const differences = [];
for (const [id, label] of CATEGORIES) {
  const problems = diffRows(ref[id], target[id]);
  differences.push(...problems.map((problem) => `【${label}】${problem}`));
  rows.push(
    `| ${label} | ${ref[id].length} | ${target[id].length} | ${problems.length} | \`${digestOf(ref[id])}\` | \`${digestOf(target[id])}\` |`,
  );
}
section(
  "2. 系统目录逐项比对（`_prisma_migrations` 不计）",
  [
    ...rows,
    "",
    "摘要：这一类全部对象的名字与定义的 sha256 前 16 位。两个库相同，即这一类逐项相同。",
    "",
    "0 差异说的是上面七类里比的那些项。不比的（属主与授权、表里的数据行、表空间、排序规则、运算符等）列在 `packages/db/README.md` 第 6 节。",
  ],
  differences,
);

const counts = countReport([
  ["参照库", ref],
  ["迁移库", target],
]);
const partitions = target.tables.filter((row) => row.part).map((row) => row.key);
section(
  "3. 数量两组口径",
  [
    ...counts.lines,
    "",
    `迁移库的分区子表 ${partitions.length} 个：${partitions.join("、") || "无"}`,
  ],
  counts.problems,
);

const verdict =
  failures.length === 0
    ? "通过：schema 未改，系统目录 0 差异，数量对得上"
    : `不通过。${failures.join("；")}`;
const report = ["# 系统目录比对报告", "", `结论：${verdict}`, "", ...body].join("\n");
const reportPath = resolve(repoRoot, options.report);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, report);

console.log(report);
console.log(`报告已写入 ${reportPath}`);
if (failures.length > 0) {
  console.error(`系统目录比对未通过。${failures.join("；")}`);
  process.exit(1);
}
