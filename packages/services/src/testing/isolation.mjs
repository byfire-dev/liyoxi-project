#!/usr/bin/env node
// pnpm test:isolation：两个会话同时跑测试，都要绿，且两边用的库名与 Redis 前缀没有交集（W0-05b）。
// 计划 第 6.3 节退出条件 ⑧ 的两半都在这里：4 个 Vitest worker 并行；两个会话同时跑。
//
// 用法：node packages/services/src/testing/isolation.mjs [--scope all|connected] [--workers <n>] [--keep] [--dry-run]
//       node packages/services/src/testing/isolation.mjs --check <甲的用量记录> <乙的用量记录>
//   不带参数   起两个子进程，各跑一遍全量测试（`pnpm test --maxWorkers=<n>`），会话标识不同（LYX_TEST_SESSION），
//              各记一份用量记录（LYX_TEST_USAGE_FILE：每建一个库、每发一个 Redis 前缀记一行）；
//              两边都退出 0 之后核对两份记录。
//   --scope    all（缺省）跑全量；connected 只跑连 PostgreSQL、Redis 的测试项目，CI 的那一步用它。
//              哪些项目算 connected 不在这里列：挂了 globalSetup 的项目都算（现在是 packages/db、packages/services）。
//              测试支架要求用它的项目挂 globalSetup（没挂时 useTestDatabase、useTestRedis 直接报错），
//              所以新的包挂上就自动进来，不用改这里，也不用改 CI。
//   --workers  每个会话几个 Vitest worker。缺省按本机的核数定：两个会话合起来不超过可用核数，
//              每个会话最多 4 个、至少 1 个（10 核的机器各 4 个，4 核各 2 个，2 核各 1 个）。
//              worker 开得比核数多，别的用例会被挤到超时：CI 的执行机只有 2 核，各开 4 个时就是这样红的。
//   --keep     跑完留着日志与用量记录。缺省：通过即删；没过才留着，并打印位置
//   --dry-run  只打印要跑什么（范围里的项目、每个会话的 worker 数），不跑测试
//   --check    不跑测试，只核对给出的两份用量记录（门禁自测的反例用）
// 核对什么：两份记录都有库、有 Redis 前缀；各有一条“4 个 worker 同时在场、4 个互不相同的库”的记录
//（packages/db/src/testing/parallel.test.ts 嵌套跑一轮确定的 4 个 worker 写的，不随 --workers 变）；
// 两边的库名没有交集，Redis 前缀没有交集。范围缩到连库的用例都没跑到时，前两项就过不了。
// 要本地的 PostgreSQL 与 Redis 在运行，并给出 DATABASE_URL、REDIS_URL（CLAUDE.md 第 9 节）。
// 退出码：0 通过；1 有一边测试没过，或核对不过；2 用法错误。
// 本脚本只在 --scope connected 时引 vitest/node（问 Vitest 各项目挂了什么），别的路径不引依赖。

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
/** “4 个 worker 同时在场”那条记录要的个数：嵌套的那一轮固定是 4 个 */
const PARALLEL_WORKERS = 4;
/** 每个会话的 worker 数上限（任务书验收第 2 条：各 4 个） */
const MAX_SESSION_WORKERS = 4;
const SCOPES = ["all", "connected"];

const say = (line) => process.stdout.write(`${line}\n`);

class UsageError extends Error {}

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
    const four = usage.parallel.some((names) => new Set(names).size >= PARALLEL_WORKERS);
    if (!four) {
      problems.push(
        `${label}没有“${PARALLEL_WORKERS} 个 worker 同时在场、${PARALLEL_WORKERS} 个互不相同的库”的记录`,
      );
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

/** 每个会话几个 worker：两个会话合起来不超过可用核数，每个会话最多 4 个、至少 1 个 */
function defaultWorkers(cores) {
  return Math.max(1, Math.min(MAX_SESSION_WORKERS, Math.floor(cores / 2)));
}

/**
 * 连 PostgreSQL、Redis 的测试项目：挂了 globalSetup 的都算。问的是 Vitest 自己解析出来的配置，
 * 不是去读各包 vitest.config.ts 的文本；只解析配置，不执行 globalSetup、不跑用例。
 */
async function connectedProjects() {
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", { root: repoRoot, watch: false });
  try {
    return vitest.projects
      .filter((project) => project.config.globalSetup.length > 0)
      .map((project) => project.name)
      .sort();
  } finally {
    await vitest.close();
  }
}

function parseArgs(args) {
  const options = { scope: "all", workers: undefined, keep: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--scope") {
      const scope = args[(index += 1)];
      if (!SCOPES.includes(scope)) {
        throw new UsageError(`--scope 后面要跟 ${SCOPES.join(" 或 ")}`);
      }
      options.scope = scope;
    } else if (arg === "--workers") {
      const workers = args[(index += 1)];
      if (!/^[1-9][0-9]?$/.test(workers ?? "")) {
        throw new UsageError("--workers 后面要跟 1–99 的整数");
      }
      options.workers = Number(workers);
    } else throw new UsageError(`不认识的参数 ${arg}`);
  }
  return options;
}

/** 跑一遍测试：输出进日志文件，返回退出码 */
function runSession(session, dir, vitestArgs) {
  const usageFile = join(dir, `usage-${session}.jsonl`);
  const logFile = join(dir, `test-${session}.log`);
  const log = createWriteStream(logFile);
  const child = spawn("pnpm", ["test", ...vitestArgs], {
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
  const options = parseArgs(args);

  const cores = availableParallelism();
  const workers = options.workers ?? defaultWorkers(cores);
  const vitestArgs = [`--maxWorkers=${workers}`];
  let what = "全量测试";
  if (options.scope === "connected") {
    const projects = await connectedProjects();
    if (projects.length === 0) {
      console.error("test:isolation：没有哪个测试项目挂了 globalSetup，connected 的范围是空的");
      return 1;
    }
    for (const project of projects) vitestArgs.push("--project", project);
    what = `连库的测试项目（挂了 globalSetup 的：${projects.join("、")}）`;
  }

  // 两个会话标识：同一个随机尾巴，各加一个字母。每次运行都不同，别的检出同时在跑也撞不上
  const stem = randomBytes(4).toString("hex");
  const sessions = [`i${stem}a`, `i${stem}b`];
  say(
    `test:isolation：两个会话（${sessions.join("、")}）同时跑${what}，各 ${workers} 个 worker（本机可用 ${cores} 核）`,
  );
  say(`  每个会话的命令：pnpm test ${vitestArgs.join(" ")}`);
  if (workers * 2 > cores && cores >= 2) {
    say(
      `  注意：两个会话合起来 ${workers * 2} 个 worker，比可用的 ${cores} 核多，别的用例可能被挤到超时`,
    );
  }
  if (options.dryRun) return 0;

  const dir = mkdtempSync(join(tmpdir(), "lyx-test-isolation-"));
  const runs = sessions.map((session) => runSession(session, dir, vitestArgs));
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
  } else {
    ok = report(readUsage(runs[0].usageFile), readUsage(runs[1].usageFile));
  }
  // 通过即删；没过的留着看
  if (ok && !options.keep) rmSync(dir, { recursive: true, force: true });
  else say(`  日志与用量记录留在 ${dir}`);
  return ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`test:isolation：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
