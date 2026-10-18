#!/usr/bin/env node
// 系统目录比对：保留首版冻结等价证明，另核对现行全部迁移。
// 用法：node infra/ci/db-catalog-diff.mjs [--ref <库>] [--target <库>] [--report <文件>]
// --ref 默认 lyx_schema_check（check.py --keep 跑全部迁移）；--target 默认 lyx_migrate_check。
// --report 默认 packages/db/dist/catalog-diff/report.md，原 required 步骤与失败时上传不变。
// 0. 两个输入库都是 PostgreSQL 17；输入库只读。
// 1. 独立从冻结草稿+00–15 建临时库，与仅执行 init 的临时库按七类+固定首版数量比。
//    临时库带本进程号，在 finally 删除；不再把现行模型强行约束成冻结首版。
// 2. 原参照/目标库按表、列、约束、索引、触发器、函数及 others 七类逐项比（_prisma_migrations 不计）。
// 3. 两个现行库的数量等于入库快照的完整七项，不再要求固定166。
// 4. 目标库的六类结构逐项等于现行快照；ADR-045 库→现行schema只读diff不得有未登记DDL。
//    仅精确的单条 DROP INDEX "ix_store_asset_search" 是首版已确认假动作，手写对象靠快照核。
// 分区子表随北京时间月份变：参照和目标要在同一月建。每节最多列40差异，总数不截断。
// 退出码0通过、1差异/数量/模型不符、2用法/环境或首版证明无法执行；连接方式见db-lib.mjs。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CATEGORIES, countReport, diffRows, digestOf, readCatalog } from "./db-lib.mjs";

import { currentSchemaProblems, frozenInitProof } from "./db-post-init-lib.mjs";
import { diffStructure, readSnapshot, structureOf } from "./db-structure-lib.mjs";

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

const options = parseArgs(process.argv.slice(2));
let ref, target, snapshot, proof;
try {
  ref = readCatalog(options.ref);
  target = readCatalog(options.target);
  snapshot = readSnapshot();
  proof = frozenInitProof();
} catch (error) {
  usage(`读不到系统目录或冻结证明未执行成功。${error.message}`);
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

section(
  "1. 首版冻结等价证明",
  [
    "冻结草稿独立出 DDL + 00–15，与仅执行 init 的库按七类逐项核对；首版数量不随当前结构变化。",
    "",
    ...proof.lines,
  ],
  proof.problems,
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

const counts = countReport(
  [
    ["参照库", ref],
    ["迁移库", target],
  ],
  snapshot.counts,
);
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

let schemaProblems;
try {
  schemaProblems = currentSchemaProblems(options.target);
} catch (error) {
  schemaProblems = [error.message];
}
section(
  "4. 现行快照与 schema",
  [
    "当前迁移库六类结构逐条等于现行快照；Prisma 库 → 当前 schema 只读 diff 仅允许 ADR-045 已确认的单条素材索引假动作。",
  ],
  [
    ...diffStructure(snapshot.sections, structureOf(target).sections, ["现行快照", "迁移库"]),
    ...schemaProblems,
  ],
);

const verdict =
  failures.length === 0
    ? "通过：首版冻结等价，现行系统目录 0 差异、快照与 schema 一致，数量对得上"
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
