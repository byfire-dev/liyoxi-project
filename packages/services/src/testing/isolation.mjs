#!/usr/bin/env node
// pnpm test:isolation：两个会话同时跑全量测试，都要绿，且两边用的库名与 Redis 前缀没有交集（W0-05b）。
// 计划 第 6.3 节退出条件 ⑧ 的两半都在这里：每个会话 4 个 Vitest worker 并行；两个会话同时跑。
//
// 用法：node packages/services/src/testing/isolation.mjs [--check <甲的用量记录> <乙的用量记录>]
//   不带参数  起两个子进程，各跑一遍 `pnpm test --maxWorkers=4`，会话标识不同（LYX_TEST_SESSION），
//             各记一份用量记录（LYX_TEST_USAGE_FILE：每建一个库、每发一个 Redis 前缀记一行）；
//             两边都退出 0 之后核对两份记录。日志与记录放在系统临时目录，结束时打印位置。
//   --check   不跑测试，只核对给出的两份用量记录（门禁自测的反例用）
// 核对什么：两份记录都有库、有 Redis 前缀；各有一条“4 个 worker 同时在场、4 个互不相同的库”的记录
//（packages/db/src/testing/parallel.test.ts 写的）；两边的库名没有交集，Redis 前缀没有交集。
// 要本地的 PostgreSQL 与 Redis 在运行，并给出 DATABASE_URL、REDIS_URL（CLAUDE.md 第 9 节）。
// 退出码：0 通过；1 有一边测试没过，或核对不过；2 用法错误。本脚本不引依赖。

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKERS = 4;

const say = (line) => process.stdout.write(`${line}\n`);

/** 读一份用量记录：一行一个 JSON。返回 { databases, redis, parallel } */
function readUsage(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`用量记录读不了：${file}`);
  }
  const usage = { databases: new Set(), redis: new Set(), parallel: [] };
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`用量记录第 ${index + 1} 行不是 JSON：${file}`);
    }
    if (record.kind === "database") usage.databases.add(String(record.value));
    else if (record.kind === "redis") usage.redis.add(String(record.value));
    else if (record.kind === "parallel" && Array.isArray(record.value)) {
      usage.parallel.push(record.value.map(String));
      for (const name of record.value) usage.databases.add(String(name));
    }
  }
  return usage;
}

/** 核对两份用量记录，返回问题清单（空 = 通过） */
function checkUsage(a, b) {
  const problems = [];
  for (const [label, usage] of [
    ["甲", a],
    ["乙", b],
  ]) {
    if (usage.databases.size === 0) problems.push(`${label}的用量记录里没有库：连库的用例没跑到`);
    if (usage.redis.size === 0) {
      problems.push(`${label}的用量记录里没有 Redis 前缀：连 Redis 的用例没跑到`);
    }
    for (const name of usage.databases) {
      if (!name.startsWith("lyx_test_")) problems.push(`${label}用了不带测试前缀的库：${name}`);
    }
    for (const prefix of usage.redis) {
      if (!prefix.startsWith("lyx:test:")) {
        problems.push(`${label}用了不带测试前缀的 Redis 键前缀：${prefix}`);
      }
    }
    const four = usage.parallel.some((names) => new Set(names).size >= WORKERS);
    if (!four) {
      problems.push(`${label}没有“${WORKERS} 个 worker 同时在场、${WORKERS} 个互不相同的库”的记录`);
    }
  }
  const shared = (left, right) => [...left].filter((value) => right.has(value)).sort();
  const databases = shared(a.databases, b.databases);
  const redis = shared(a.redis, b.redis);
  if (databases.length > 0) problems.push(`库名有交集：${databases.join("、")}`);
  if (redis.length > 0) problems.push(`Redis 前缀有交集：${redis.join("、")}`);
  return problems;
}

function report(a, b) {
  const problems = checkUsage(a, b);
  say(`  甲：库 ${a.databases.size} 个，Redis 前缀 ${a.redis.size} 个`);
  say(`  乙：库 ${b.databases.size} 个，Redis 前缀 ${b.redis.size} 个`);
  if (problems.length === 0) {
    say("  库名交集 0 个，Redis 前缀交集 0 个");
    return true;
  }
  for (const problem of problems) console.error(`  不通过：${problem}`);
  return false;
}

/** 跑一遍全量测试：输出进日志文件，返回退出码 */
function runSession(session, dir) {
  const usageFile = join(dir, `usage-${session}.jsonl`);
  const logFile = join(dir, `test-${session}.log`);
  const log = createWriteStream(logFile);
  const child = spawn("pnpm", ["test", `--maxWorkers=${WORKERS}`], {
    cwd: repoRoot,
    env: { ...process.env, LYX_TEST_SESSION: session, LYX_TEST_USAGE_FILE: usageFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      log.write(`\npnpm 没跑起来：${error.message}\n`);
      resolve(-1);
    });
    child.on("close", (code) => resolve(code ?? -1));
  }).then((code) => new Promise((resolve) => log.end(() => resolve(code))));
  return { session, usageFile, logFile, done };
}

/** 日志的最后几行（测试的汇总在那里） */
function tail(file, lines) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "（日志读不了）";
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--check") {
    if (args.length !== 3) {
      console.error("test:isolation：--check 后面要跟两份用量记录的路径");
      return 2;
    }
    say("test:isolation（只核对用量记录）");
    return report(readUsage(args[1]), readUsage(args[2])) ? 0 : 1;
  }
  if (args.length > 0) {
    console.error(`test:isolation：不认识的参数 ${args[0]}`);
    return 2;
  }

  // 两个会话标识：同一个随机尾巴，各加一个字母。每次运行都不同，别的检出同时在跑也撞不上
  const stem = randomBytes(4).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "lyx-test-isolation-"));
  const runs = [runSession(`i${stem}a`, dir), runSession(`i${stem}b`, dir)];
  say(
    `test:isolation：两个会话（${runs.map((run) => run.session).join("、")}）同时跑全量测试，各 ${WORKERS} 个 worker`,
  );
  say(`  日志与用量记录在 ${dir}`);
  const codes = await Promise.all(runs.map((run) => run.done));

  let ok = true;
  for (const [index, run] of runs.entries()) {
    const code = codes[index];
    say(`  会话 ${run.session}：退出码 ${code}`);
    // 通过时只留汇总那几行；没过时把日志的末尾打出来
    say(
      tail(run.logFile, code === 0 ? 6 : 80)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
    if (code !== 0) ok = false;
  }
  if (!ok) {
    console.error("test:isolation：有一边的测试没过，不再核对用量记录");
    return 1;
  }
  return report(readUsage(runs[0].usageFile), readUsage(runs[1].usageFile)) ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`test:isolation：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
