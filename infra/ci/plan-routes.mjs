#!/usr/bin/env node
// 计划 第 8.2 节“20 份接口文档”那张表由路由清单生成（W0-10；计划 第 5.7 节“实现进度”行）。
// 每条 V1.0 接口归哪个里程碑写在 packages/contract/src/routes/milestones.ts，契约的生成脚本把它带进
// packages/contract/generated/routes.json；本脚本只读那份 JSON 与计划文档。
//
// 用法（在仓库根目录）：
//   node infra/ci/plan-routes.mjs --check            V1.0 的接口都有里程碑；计划里那张表与现生成的无差异；行与列的合计相符
//   node infra/ci/plan-routes.mjs --write            重写计划里那张表（改了归属之后跑）
//   --summary <文件>   与上面任一个合用：另出一份业主评审用的汇总（文档 × 里程碑 × operationId，Markdown）
//   --routes <文件>、--plan <文件>   换路由清单、计划文档的路径（用例与反例用）
// 表怎么认：计划文档里以“| 文档 | V1.0 |”开头的那一行是表头，往下连着的表格行都算这张表。
// 每行第一格的标题照原样保留（按链接里的 api/<文档>.md 认是哪份文档）；不是接口文档的行（x01 那一行）原样保留；
// “合计”一行重算。清单里有、表里没有的文档，按“[<文档>](api/<文档>.md)”补在接口文档各行的末尾。
// 退出码：0 通过；1 有接口没有里程碑、表有差异或合计不符；2 用法或环境错误。本脚本不引依赖。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const DEFAULTS = {
  routes: "packages/contract/generated/routes.json",
  plan: "docs/08-development-plan.md",
};
const HEADER = /^\| 文档 \| V1\.0 \|/;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { ...DEFAULTS, check: false, write: false, summary: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check" || flag === "--write") {
      options[flag.slice(2)] = true;
      continue;
    }
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!(name in DEFAULTS) && name !== "summary") throw new UsageError(`不认识的参数 ${flag}`);
    if (argv[index + 1] === undefined) throw new UsageError(`${flag} 后面要跟一个值`);
    options[name] = argv[index + 1];
    index += 1;
  }
  if (options.check === options.write) throw new UsageError("要带 --check 或 --write 其中一个");
  return options;
}

const cells = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
const row = (values) => `|${values.map((value) => (value === "" ? " " : ` ${value} `)).join("|")}|`;

/** 各文档 × 里程碑的条数。返回 { counts: Map<文档, Map<里程碑, 数>>, problems } */
export function tally(routes, milestones) {
  const counts = new Map();
  const problems = [];
  for (const route of routes) {
    if (route.version !== "V1.0") continue;
    if (!milestones.includes(route.milestone)) {
      problems.push(`${route.operationId} 没有里程碑，或取值不在 ${milestones.join("、")} 之内`);
      continue;
    }
    const mine = counts.get(route.doc) ?? new Map();
    counts.set(route.doc, mine);
    mine.set(route.milestone, (mine.get(route.milestone) ?? 0) + 1);
  }
  return { counts, problems };
}

/** 由计划文档现有的表与路由清单生成新表。返回 { start, end, lines, problems }：表在文档里的行范围与新的各行 */
export function renderTable(planText, routes) {
  const all = planText.split("\n");
  const start = all.findIndex((line) => HEADER.test(line));
  if (start < 0) throw new UsageError("计划文档里找不到以“| 文档 | V1.0 |”开头的表头");
  let end = start;
  while (end < all.length && all[end].startsWith("|")) end += 1;
  const header = cells(all[start]);
  const milestones = header.slice(2);
  const { counts, problems } = tally(routes, milestones);
  const total = (doc) => [...(counts.get(doc)?.values() ?? [])].reduce((sum, n) => sum + n, 0);
  const docRow = (label, doc) =>
    row([
      label,
      String(total(doc)),
      ...milestones.map((m) => String(counts.get(doc)?.get(m) ?? "")),
    ]);

  const lines = [all[start], all[start + 1]];
  const seen = new Set();
  const kept = [];
  for (const line of all.slice(start + 2, end)) {
    const label = cells(line)[0] ?? "";
    const doc = /\]\(api\/([a-z0-9-]+)\.md\)/.exec(label)?.[1];
    if (doc !== undefined && counts.has(doc)) {
      seen.add(doc);
      lines.push(docRow(label, doc));
    } else if (doc !== undefined && /^[maph]\d\d-/.test(doc)) {
      problems.push(`表里有 ${doc} 一行，路由清单里却没有这份文档的 V1.0 接口`);
    } else if (label !== "合计") {
      kept.push(line);
    }
  }
  for (const doc of [...counts.keys()].filter((name) => !seen.has(name)).sort()) {
    lines.push(docRow(`[${doc}](api/${doc}.md)`, doc));
  }
  lines.push(...kept);
  const grand = [...counts.keys()].reduce((sum, doc) => sum + total(doc), 0);
  const columns = milestones.map((m) =>
    [...counts.values()].reduce((sum, mine) => sum + (mine.get(m) ?? 0), 0),
  );
  lines.push(row(["合计", String(grand), ...columns.map(String)]));
  const expected = routes.filter((route) => route.version === "V1.0").length;
  if (grand !== expected || columns.reduce((sum, n) => sum + n, 0) !== expected) {
    problems.push(
      `合计不符：V1.0 的接口 ${expected} 条，表里行合计 ${grand}、列合计 ${columns.reduce((s, n) => s + n, 0)}`,
    );
  }
  return { start, end, lines, problems, milestones, counts };
}

function renderSummary(routes, table) {
  const out = [
    "# 路由的里程碑归属（业主评审用）",
    "",
    "由 `packages/contract/generated/routes.json` 生成；归属写在 `packages/contract/src/routes/milestones.ts`，一行一条。",
    "要改某一条：改那个文件里它的里程碑，再跑 `pnpm contract:generate` 与 `node infra/ci/plan-routes.mjs --write`。",
    "",
    "## 各文档 × 里程碑的条数（同计划 第 8.2 节）",
    "",
    ...table.lines,
  ];
  const v1 = routes.filter((route) => route.version === "V1.0");
  for (const doc of [...new Set(v1.map((route) => route.doc))]) {
    out.push("", `## ${doc}`);
    for (const milestone of table.milestones) {
      const mine = v1.filter((route) => route.doc === doc && route.milestone === milestone);
      if (mine.length === 0) continue;
      out.push("", `### ${doc} · ${milestone}（${mine.length}）`, "");
      out.push("| operationId | 方法与路径 | 摘要 |", "| --- | --- | --- |");
      for (const route of mine) {
        const summary = String(route.summary ?? "").replaceAll("|", "\\|");
        out.push(`| \`${route.operationId}\` | ${route.method} \`${route.path}\` | ${summary} |`);
      }
    }
  }
  const later = routes.filter((route) => route.version !== "V1.0");
  out.push("", `## 只登记、V1.0 不落地的（${later.length}）`, "");
  out.push("| operationId | 文档 | 版本 |", "| --- | --- | --- |");
  for (const route of later)
    out.push(`| \`${route.operationId}\` | ${route.doc} | ${route.version} |`);
  return `${out.join("\n")}\n`;
}

function main(argv) {
  const options = parseArgs(argv);
  const read = (path, what) => {
    try {
      return readFileSync(resolve(repoRoot, path), "utf8");
    } catch {
      throw new UsageError(`读不了${what} ${path}`);
    }
  };
  let routes;
  try {
    routes = JSON.parse(read(options.routes, "路由清单"));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`路由清单 ${options.routes} 不是合法的 JSON`);
  }
  const planText = read(options.plan, "计划文档");
  const table = renderTable(planText, routes);
  const all = planText.split("\n");
  const current = all.slice(table.start, table.end);
  const problems = [...table.problems];

  if (options.summary) {
    mkdirSync(dirname(resolve(repoRoot, options.summary)), { recursive: true });
    writeFileSync(resolve(repoRoot, options.summary), renderSummary(routes, table));
    console.log(`里程碑归属汇总已写入 ${options.summary}`);
  }
  if (options.write && problems.length === 0) {
    const next = [...all.slice(0, table.start), ...table.lines, ...all.slice(table.end)].join("\n");
    if (next !== planText) writeFileSync(resolve(repoRoot, options.plan), next);
    console.log(`${options.plan} 第 8.2 节的表${next === planText ? "没有变化" : "已重写"}`);
  }
  if (options.check && current.join("\n") !== table.lines.join("\n")) {
    const length = Math.max(current.length, table.lines.length);
    for (let index = 0; index < length; index += 1) {
      if (current[index] === table.lines[index]) continue;
      problems.push(
        `计划 第 8.2 节的表与路由清单不一致（跑 node infra/ci/plan-routes.mjs --write 重写）：\n` +
          `    文档里：${current[index] ?? "（没有这一行）"}\n    应当是：${table.lines[index] ?? "（没有这一行）"}`,
      );
    }
  }
  if (problems.length > 0) {
    console.error(`里程碑归属核对未通过：\n- ${problems.join("\n- ")}`);
    return 1;
  }
  if (options.check) {
    const total = routes.filter((route) => route.version === "V1.0").length;
    console.log(
      `里程碑归属核对通过：V1.0 的 ${total} 条都有里程碑，计划 第 8.2 节的表与路由清单一致，行与列的合计都是 ${total}。`,
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(
      `里程碑归属核对：${error.message}。用法：node infra/ci/plan-routes.mjs --check | --write [--summary <文件>]`,
    );
    process.exit(2);
  }
}
