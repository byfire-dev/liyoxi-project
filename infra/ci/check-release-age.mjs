#!/usr/bin/env node
// 发布时长检查：锁文件里的每个版本都须发布满 7 天（02 第 5.1 节第 2 条；ADR-035）。
//
// 用法：node infra/ci/check-release-age.mjs [--since <git 引用>] [--registry <地址>]
//   默认            查 pnpm-lock.yaml 里的全部版本，外加 package.json 的 packageManager
//   --since <引用>  只查相对该引用新增的版本（引用上没有锁文件时等于全查）
//   --registry      查发布时间用的 registry；不给时依次取环境变量 npm_config_registry、
//                   `pnpm config get registry`、https://registry.npmjs.org/
// 另查 pnpm-workspace.yaml：须有 minimumReleaseAge: 10080，不得有 minimumReleaseAgeExclude。
// 退出码：0 通过；1 有违规；2 用法或环境错误。
// 本脚本不引依赖，在仓库根目录跑。只认 pnpm 锁文件 9.0 版；作用域 registry 不支持。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_MINUTES = 10080;
const REQUIRED_MS = REQUIRED_MINUTES * 60 * 1000;
const CONCURRENCY = 8;
const RETRIES = 3;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const root = process.cwd();

function fail(message) {
  console.error(`发布时长检查：${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { since: null, registry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--since" || arg === "--registry") {
      const value = argv[i + 1];
      if (!value) fail(`${arg} 后面要跟一个值`);
      options[arg.slice(2)] = value;
      i += 1;
    } else {
      fail(`不认识的参数 ${arg}。用法见脚本开头的注释`);
    }
  }
  return options;
}

/** 从锁文件文本里取出 packages 段的全部 “包名@版本” */
function parseLockfile(text, label) {
  const versionLine = text.match(/^lockfileVersion:\s*'?([\d.]+)'?\s*$/m);
  if (!versionLine || versionLine[1] !== "9.0") {
    fail(`${label} 的 lockfileVersion 不是 9.0，本脚本不认识`);
  }
  const entries = new Map();
  const unknown = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line.trimEnd() === "packages:";
      continue;
    }
    if (!inPackages) continue;
    const match = line.match(/^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'":][^:]*)):\s*$/);
    if (!match) continue;
    const key = match[1] ?? match[2] ?? match[3];
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (at <= 0 || !SEMVER.test(version)) {
      unknown.push(key);
      continue;
    }
    entries.set(key, { name, version });
  }
  return { entries, unknown };
}

/** package.json 的 packageManager 写的 pnpm 版本，没有则返回 null */
function parsePackageManager(text) {
  try {
    const value = JSON.parse(text).packageManager;
    const match = typeof value === "string" ? value.match(/^pnpm@([^+]+)/) : null;
    return match ? { name: "pnpm", version: match[1] } : null;
  } catch {
    return null;
  }
}

function gitShow(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function resolveRegistry(explicit) {
  const fromEnv = process.env.npm_config_registry;
  let value = explicit ?? (fromEnv && fromEnv !== "undefined" ? fromEnv : null);
  if (!value) {
    try {
      value = execFileSync("pnpm", ["config", "get", "registry"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      value = null;
    }
  }
  if (!value || value === "undefined") value = "https://registry.npmjs.org/";
  return value.endsWith("/") ? value : `${value}/`;
}

async function fetchTimes(registry, name) {
  const url = `${registry}${name.replace("/", "%2F")}`;
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      return body.time ?? {};
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`取不到 ${name} 的发布时间（${url}）：${lastError?.message}`);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const options = parseArgs(process.argv.slice(2));
const violations = [];

// 一、工作区设置
const workspacePath = join(root, "pnpm-workspace.yaml");
if (!existsSync(workspacePath)) fail("找不到 pnpm-workspace.yaml，须在仓库根目录跑");
const workspace = readFileSync(workspacePath, "utf8");
if (!new RegExp(`^minimumReleaseAge:\\s*${REQUIRED_MINUTES}\\s*(?:#.*)?$`, "m").test(workspace)) {
  violations.push(`pnpm-workspace.yaml 里没有 minimumReleaseAge: ${REQUIRED_MINUTES}`);
}
if (/^minimumReleaseAgeExclude\s*:/m.test(workspace)) {
  violations.push(
    "pnpm-workspace.yaml 里有 minimumReleaseAgeExclude：不许用豁免（确需豁免要业主确认）",
  );
}

// 二、要查哪些版本
const lockPath = join(root, "pnpm-lock.yaml");
if (!existsSync(lockPath)) fail("找不到 pnpm-lock.yaml，须在仓库根目录跑");
const current = parseLockfile(readFileSync(lockPath, "utf8"), "pnpm-lock.yaml");
const targets = new Map(current.entries);
for (const key of current.unknown) {
  violations.push(`${key}：不是 registry 上的版本，核对不了发布时间`);
}
const manifestPath = join(root, "package.json");
const packageManager = existsSync(manifestPath)
  ? parsePackageManager(readFileSync(manifestPath, "utf8"))
  : null;
if (packageManager) {
  targets.set(`${packageManager.name}@${packageManager.version}`, packageManager);
}

if (options.since) {
  const oldLock = gitShow(options.since, "pnpm-lock.yaml");
  if (oldLock !== null) {
    const old = parseLockfile(oldLock, `${options.since}:pnpm-lock.yaml`);
    for (const key of old.entries.keys()) targets.delete(key);
  }
  const oldManifest = gitShow(options.since, "package.json");
  const oldPackageManager = oldManifest === null ? null : parsePackageManager(oldManifest);
  if (oldPackageManager) {
    targets.delete(`${oldPackageManager.name}@${oldPackageManager.version}`);
  }
}

// 三、逐个查发布时间
const registry = resolveRegistry(options.registry);
const now = Date.now();
const names = [...new Set([...targets.values()].map((target) => target.name))].sort();
let timesByName;
try {
  timesByName = new Map(
    await mapLimit(names, CONCURRENCY, async (name) => [name, await fetchTimes(registry, name)]),
  );
} catch (error) {
  fail(error.message);
}

const checked = [];
for (const [key, { name, version }] of targets) {
  const published = timesByName.get(name)?.[version];
  if (!published) {
    violations.push(`${key}：registry 上查不到这个版本的发布时间`);
    continue;
  }
  const ageMs = now - new Date(published).getTime();
  checked.push({ key, published, ageMs });
  if (!(ageMs >= REQUIRED_MS)) {
    const days = (ageMs / 86_400_000).toFixed(1);
    violations.push(`${key}：发布于 ${published}，才 ${days} 天，未满 7 天`);
  }
}

const scope = options.since ? `相对 ${options.since} 新增的` : "锁文件里的全部";
if (violations.length > 0) {
  console.error(
    `发布时长检查未通过，共 ${violations.length} 处（${scope}版本，registry：${registry}）：`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

checked.sort((a, b) => a.ageMs - b.ageMs);
console.log(
  `发布时长检查通过：${scope} ${checked.length} 个版本都已发布满 7 天；` +
    `minimumReleaseAge: ${REQUIRED_MINUTES} 在，没有 minimumReleaseAgeExclude。`,
);
console.log(`registry：${registry}；核对时间：${new Date(now).toISOString()}`);
if (checked.length > 0) {
  console.log("发布最晚的几个：");
  for (const { key, published, ageMs } of checked.slice(0, 5)) {
    console.log(`  ${key}  ${published}  已满 ${(ageMs / 86_400_000).toFixed(1)} 天`);
  }
}
