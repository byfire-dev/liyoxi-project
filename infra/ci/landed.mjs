#!/usr/bin/env node
// 已落地判定与待落地清单（W0-10；计划 第 5.7 节“实现进度”行）。
// 一条 V1.0 的接口“已落地”= 挂载了真实处理器 + 至少一条接口层测试引用它的 operationId + 不在留桩清单。
// 不靠手工标记：三个条件都从仓库里读。V1.1 的路由只登记，不在清单内。
//
// 用法（在仓库根目录）：
//   node infra/ci/landed.mjs --report [--out <文件>]   出清单：已落地数、待落地数、按里程碑分组的待落地接口（Markdown）
//   node infra/ci/landed.mjs --check                   待落地数高于基线即非 0 退出（待落地数只减不增）
//   --require <里程碑,…>   与上面任一个合用：这几个里程碑还有待落地的接口即非 0 退出（里程碑退出条件用，如 --require M0,M1）
// 读什么（括号里是缺省值；用例与反例用这几个参数换路径）：
//   --routes <文件>     路由清单（packages/contract/generated/routes.json，契约的生成物）
//   --mounted <文件>    已挂载真实处理器的 operationId 清单，JSON 字符串数组；探活用登记键
//                      （apps/api/dist/mounted-operations.json）。由 apps/api 的测试装配导出（W0-22 接上）；
//                      文件不存在按空集算，所以它没生成时不会有接口被误判成已落地
//   --tests <目录>      接口层测试所在的目录（apps/api）：其下 *.test.ts 里以字符串字面量出现的 operationId 算被引用
//   --stubs <目录>      留桩清单（docs/plan/stubs）：只认状态为“留桩中”的文件，取“留桩内容”一行里反引号括起的 operationId
//   --baseline <文件>   基线（infra/ci/landed-baseline.txt）：一行一个数，读最后一行；后一行不得大于前一行
// 探活 5 条没有 operationId，清单里用登记键（如 hooks.healthz.get）。
// 退出码：0 通过；1 待落地数高于基线、基线文件不合规，或 --require 的里程碑没清零；2 用法或环境错误。
// 本脚本不引依赖。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

const DEFAULTS = {
  routes: "packages/contract/generated/routes.json",
  mounted: "apps/api/dist/mounted-operations.json",
  tests: "apps/api",
  stubs: "docs/plan/stubs",
  baseline: "infra/ci/landed-baseline.txt",
};

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { ...DEFAULTS, report: false, check: false, out: null, require: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--report" || flag === "--check") {
      options[flag.slice(2)] = true;
      continue;
    }
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!(name in DEFAULTS) && name !== "out" && name !== "require") {
      throw new UsageError(`不认识的参数 ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} 后面要跟一个值`);
    options[name] = name === "require" ? value.split(",").filter(Boolean) : value;
    index += 1;
  }
  if (!options.report && !options.check) throw new UsageError("要带 --report 或 --check");
  return options;
}

const at = (path) => resolve(repoRoot, path);

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(at(path), "utf8");
  } catch {
    throw new UsageError(`读不了${what} ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${what} ${path} 不是合法的 JSON`);
  }
}

/** 目录下全部 *.test.ts（不进 node_modules、dist 与点开头的目录） */
function testFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...testFiles(path));
    else if (name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/** 接口层测试里以字符串字面量出现的名字（单引号、双引号、反引号） */
function referencedInTests(dir) {
  const names = new Set();
  for (const file of testFiles(at(dir))) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'`]([A-Za-z][A-Za-z0-9.]*)["'`]/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

/** 留桩清单：状态为“留桩中”的文件，“留桩内容”一行里反引号括起的名字 */
function stubbed(dir) {
  const names = new Set();
  if (!existsSync(at(dir))) return names;
  for (const name of readdirSync(at(dir)).sort()) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const lines = readFileSync(join(at(dir), name), "utf8").split("\n");
    const cell = (key) =>
      lines.find((line) => new RegExp(`^\\|\\s*${key}\\s*\\|`).test(line))?.split("|")[2] ?? "";
    if (cell("状态").trim() !== "留桩中") continue;
    for (const match of cell("留桩内容").matchAll(/`([^`]+)`/g)) names.add(match[1]);
  }
  return names;
}

/** 基线文件：去掉注释与空行后一行一个非负整数，后一行不得大于前一行。返回 { baseline, problems } */
export function readBaseline(text) {
  const values = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const problems = [];
  if (values.length === 0) problems.push("基线文件里没有数");
  values.forEach((value, index) => {
    if (!/^\d+$/.test(value)) problems.push(`基线文件第 ${index + 1} 个值“${value}”不是非负整数`);
    else if (index > 0 && Number(value) > Number(values[index - 1])) {
      problems.push(
        `基线只能往下降：第 ${index + 1} 个值 ${value} 大于上一个 ${values[index - 1]}`,
      );
    }
  });
  return { baseline: Number(values.at(-1)), problems };
}

/** 逐条判定。返回 V1.0 的全部条目，各带 landed 与缺什么 */
export function judge(routes, { mounted, tested, stubs }) {
  return routes
    .filter((route) => route.version === "V1.0")
    .map((route) => {
      const id = route.operationId;
      const missing = [];
      if (!mounted.has(id)) missing.push("处理器");
      if (!tested.has(id)) missing.push("接口层测试");
      if (stubs.has(id)) missing.push("在留桩清单");
      return { ...route, landed: missing.length === 0, missing };
    });
}

function renderReport(judged, baseline) {
  const pending = judged.filter((item) => !item.landed);
  const milestones = [...new Set(judged.map((item) => item.milestone ?? "未定"))].sort();
  const lines = [
    "# 待落地清单",
    "",
    `V1.0 接口 ${judged.length} 条：已落地 ${judged.length - pending.length}，待落地 ${pending.length}；基线 ${baseline}。V1.1 的路由只登记，不在其内。`,
    "",
    "| 里程碑 | 应落地 | 已落地 | 待落地 |",
    "| --- | --- | --- | --- |",
    ...milestones.map((milestone) => {
      const mine = judged.filter((item) => (item.milestone ?? "未定") === milestone);
      const left = mine.filter((item) => !item.landed).length;
      return `| ${milestone} | ${mine.length} | ${mine.length - left} | ${left} |`;
    }),
  ];
  for (const milestone of milestones) {
    const mine = pending.filter((item) => (item.milestone ?? "未定") === milestone);
    if (mine.length === 0) continue;
    lines.push("", `## ${milestone}（待落地 ${mine.length}）`, "");
    lines.push("| operationId | 文档 | 方法与路径 | 还缺 |", "| --- | --- | --- | --- |");
    for (const item of mine) {
      lines.push(
        `| \`${item.operationId}\` | ${item.doc} | ${item.method} \`${item.path}\` | ${item.missing.join("、")} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const options = parseArgs(argv);
  const routes = readJson(options.routes, "路由清单");
  if (!Array.isArray(routes)) throw new UsageError(`路由清单 ${options.routes} 应是数组`);
  const mountedList = existsSync(at(options.mounted))
    ? readJson(options.mounted, "已挂载清单")
    : [];
  if (!Array.isArray(mountedList))
    throw new UsageError(`已挂载清单 ${options.mounted} 应是字符串数组`);
  let baselineText;
  try {
    baselineText = readFileSync(at(options.baseline), "utf8");
  } catch {
    throw new UsageError(`读不了基线文件 ${options.baseline}`);
  }
  const { baseline, problems } = readBaseline(baselineText);

  const judged = judge(routes, {
    mounted: new Set(mountedList),
    tested: referencedInTests(options.tests),
    stubs: stubbed(options.stubs),
  });
  const pending = judged.filter((item) => !item.landed);

  if (options.report) {
    const report = renderReport(judged, problems.length > 0 ? "（基线文件不合规）" : baseline);
    if (options.out) {
      mkdirSync(dirname(at(options.out)), { recursive: true });
      writeFileSync(at(options.out), report);
      console.log(`待落地清单已写入 ${options.out}`);
    } else {
      process.stdout.write(report);
    }
  }

  const failures = [...problems];
  if (options.check && problems.length === 0) {
    if (pending.length > baseline) {
      failures.push(
        `待落地数 ${pending.length} 高于基线 ${baseline}：待落地数只减不增。新增的 V1.0 接口要同 PR 落地；` +
          `已落地的接口不能退回（处理器被摘、接口层测试被删、被登记成留桩）。清单：node infra/ci/landed.mjs --report`,
      );
    } else {
      console.log(
        `待落地 ${pending.length}，已落地 ${judged.length - pending.length}，基线 ${baseline}：没有超过基线。` +
          (pending.length < baseline
            ? `基线可以降到 ${pending.length}：在 ${options.baseline} 末尾加一行。`
            : ""),
      );
    }
  }
  for (const milestone of options.require) {
    const left = pending.filter((item) => item.milestone === milestone);
    if (left.length > 0) {
      failures.push(
        `里程碑 ${milestone} 还有 ${left.length} 条接口待落地：${left
          .slice(0, 5)
          .map((item) => item.operationId)
          .join("、")}${left.length > 5 ? " 等" : ""}`,
      );
    }
  }
  if (failures.length > 0) {
    console.error(`已落地判定未通过：\n- ${failures.join("\n- ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(
      `已落地判定：${error.message}。用法：node infra/ci/landed.mjs --report [--out <文件>] | --check`,
    );
    process.exit(2);
  }
}
