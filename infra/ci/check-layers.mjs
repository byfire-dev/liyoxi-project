#!/usr/bin/env node
// 分层登记核对：infra/ci/layers.json 自洽，并与 packages/services/src 下的模块目录一一对应
//（D7 第 2.3 节：新增模块先登记层，否则检查失败）。
//
// 用法：node infra/ci/check-layers.mjs [--layers <layers.json>] [--services-dir <目录>]
//   不带参数：核对本仓库。根脚本 pnpm depcheck 先跑它，再跑 dependency-cruiser。
//   --layers        换一份登记表（用例里造反例用）
//   --services-dir  换一个模块目录（用例里造反例用）；缺省是仓库根下登记表里的 servicesDir
// 口径：
//   1. 登记表：layers 不重复；每个模块的层在 layers 里；每层都有同层策略（free 或 whitelist）；
//      白名单两端都是该层已登记的模块，不引自己；nonModuleDirs 与模块名不重叠。
//   2. 目录：模块目录下的每个子目录，要么是已登记的模块，要么在 nonModuleDirs 里；
//      每个已登记的模块都有目录，目录里有 index.ts。nonModuleDirs 里的目录可以还没建。
//   3. 各层的模块数不在这里写死；“31 个模块及其层”由 infra/ci/test/layers.test.ts 对照文档断言。
// 退出码：0 通过；1 有不一致；2 用法或环境错误。
// 本脚本不引依赖。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const POLICIES = ["free", "whitelist"];
const MODULE_NAME = /^[a-z][a-z0-9-]*$/;

function fail(message) {
  console.error(`分层登记核对：${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { layers: join(repoRoot, "infra/ci/layers.json"), servicesDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--layers" && flag !== "--services-dir") fail(`不认识的参数 ${flag}`);
    if (value === undefined) fail(`${flag} 后面要跟路径`);
    const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value);
    if (flag === "--layers") options.layers = absolute;
    else options.servicesDir = absolute;
    index += 1;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

let registry;
try {
  registry = JSON.parse(readFileSync(options.layers, "utf8"));
} catch (error) {
  fail(`读不了登记表 ${options.layers}。${error.message}`);
}

const problems = [];
const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// ---------- 1. 登记表自洽 ----------

if (typeof registry.servicesDir !== "string" || registry.servicesDir === "") {
  fail("登记表缺 servicesDir");
}
if (!isStringArray(registry.layers) || registry.layers.length === 0) fail("登记表缺 layers");
if (!isRecord(registry.modules)) fail("登记表缺 modules");
if (!isRecord(registry.sameLayer)) fail("登记表缺 sameLayer");
if (!isStringArray(registry.nonModuleDirs)) fail("登记表缺 nonModuleDirs");

const layers = registry.layers;
const moduleNames = Object.keys(registry.modules);
const modulesOf = (layer) => moduleNames.filter((name) => registry.modules[name] === layer);

if (new Set(layers).size !== layers.length) problems.push("layers 里有重复的层");

for (const name of moduleNames) {
  if (!MODULE_NAME.test(name))
    problems.push(`模块名 ${name} 不合规：小写字母开头，只含小写字母、数字、连字符`);
  if (!layers.includes(registry.modules[name])) {
    problems.push(`模块 ${name} 的层 ${JSON.stringify(registry.modules[name])} 不在 layers 里`);
  }
}

for (const dir of registry.nonModuleDirs) {
  if (moduleNames.includes(dir)) problems.push(`${dir} 同时出现在 modules 与 nonModuleDirs 里`);
}

for (const layer of Object.keys(registry.sameLayer)) {
  if (!layers.includes(layer)) problems.push(`sameLayer 里的 ${layer} 不在 layers 里`);
}

for (const layer of layers) {
  const rule = registry.sameLayer[layer];
  if (!isRecord(rule)) {
    problems.push(`${layer} 没有同层策略`);
    continue;
  }
  if (!POLICIES.includes(rule.policy)) {
    problems.push(
      `${layer} 的同层策略 ${JSON.stringify(rule.policy)} 不认识，只能是 ${POLICIES.join(" 或 ")}`,
    );
    continue;
  }
  if (rule.policy === "free") {
    if (rule.allow !== undefined) problems.push(`${layer} 的同层策略是 free，不该带白名单`);
    continue;
  }
  if (!isRecord(rule.allow)) {
    problems.push(`${layer} 的同层策略是 whitelist，要带 allow（可以是空对象）`);
    continue;
  }
  const peers = modulesOf(layer);
  for (const [from, targets] of Object.entries(rule.allow)) {
    if (!peers.includes(from)) problems.push(`${layer} 白名单的起点 ${from} 不是该层已登记的模块`);
    if (!isStringArray(targets)) {
      problems.push(`${layer} 白名单里 ${from} 的值要是模块名数组`);
      continue;
    }
    for (const to of targets) {
      if (to === from) problems.push(`${layer} 白名单里 ${from} 引了自己`);
      else if (!peers.includes(to)) {
        problems.push(`${layer} 白名单 ${from} → ${to}：${to} 不是该层已登记的模块`);
      }
    }
  }
}

// ---------- 2. 与模块目录一一对应 ----------

const servicesDir = options.servicesDir ?? join(repoRoot, registry.servicesDir);
const shown = relative(process.cwd(), servicesDir) || ".";

if (!existsSync(servicesDir) || !statSync(servicesDir).isDirectory()) {
  fail(`模块目录 ${servicesDir} 不存在`);
}

const dirs = readdirSync(servicesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const dir of dirs) {
  if (!moduleNames.includes(dir) && !registry.nonModuleDirs.includes(dir)) {
    problems.push(
      `${shown}/${dir}：目录没有登记。新增模块先在 infra/ci/layers.json 的 modules 里登记层`,
    );
  }
}

for (const name of moduleNames) {
  if (!dirs.includes(name)) {
    problems.push(`模块 ${name} 已登记，但 ${shown}/${name} 不存在`);
  } else if (!existsSync(join(servicesDir, name, "index.ts"))) {
    problems.push(`${shown}/${name}：缺 index.ts（模块对外只暴露 index.ts）`);
  }
}

// ---------- 结果 ----------

if (problems.length > 0) {
  console.error(`分层登记核对未通过：${problems.length} 处不一致`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const perLayer = layers.map((layer) => `${layer} ${modulesOf(layer).length}`).join("、");
console.log(
  `分层登记核对通过：${moduleNames.length} 个模块（${perLayer}），与 ${shown} 下的目录一一对应`,
);
