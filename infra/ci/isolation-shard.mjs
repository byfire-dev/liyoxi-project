#!/usr/bin/env node
// 测试隔离的全量，分片跑（计划 第 6.3 节退出条件 ⑧；必过检查的并行化）。
//
// pnpm test:isolation --scope connected 是两个会话各跑一遍全部连库的测试项目，再核对两边用的库名与 Redis 前缀
// 没有交集。这一遍在 2 核的执行机上已经超过 10 分钟。这里把同一批用例文件分成 n 片，CI 一个任务跑一片，几片并行；
// 每一片里照旧是两个会话同时跑、各记一份用量记录，核对交给 packages/services/src/testing/isolation.mjs --check
//（那个脚本没有动：两边都要有库、有 Redis 前缀、有“4 个 worker 同时在场”的记录，库名与前缀没有交集）。
//
// 范围  与 --scope connected 相同：挂了 globalSetup 的测试项目的全部用例文件。问的是 Vitest 解析出来的配置与它列出的文件。
// 分法  Vitest 配置里的分片器（跑测试时 --shard 用的同一个：文件路径取哈希、排序后按个数等分）。n 片互不重叠，合起来是全部。
// 另带  每一片都带上两份测试支架自己的用例（本来就在这一片里的不重复）：
//         packages/db/src/testing/parallel.test.ts              只有它写“4 个 worker 同时在场”那条记录
//         packages/services/src/testing/redis-isolation.test.ts  保证每一片都用到 Redis 前缀
//       这样每一片都按不分片时的完整口径核对，核对不用为分片开口子。代价是这两个文件在别的片里各多跑一遍（几秒）。
// 跑完再对一遍：两个会话实际跑的用例文件数都等于这一片的名单（连同另带的）的个数，对不上即失败。
//
// 用法（在仓库根目录）：
//   node infra/ci/isolation-shard.mjs --shard <i>/<n> [--workers <w>] [--keep] [--dry-run]
//       两个会话同时跑第 i 片（共 n 片）。--workers：每个会话几个 Vitest worker，缺省同 test:isolation
//       （两个会话合起来不超过可用核数，各最多 4 个、至少 1 个）。--keep：通过了也留着日志与用量记录。
//       --dry-run：只打印每个会话要跑的命令与文件数，不跑
//   node infra/ci/isolation-shard.mjs --list [--shard <i>/<n>]
//       不跑，列出范围里（给了 --shard 就是这一片里）的用例文件，一行一个：项目、制表符、相对仓库根的路径。
//       不含“另带”的那两份（它们算在自己那一片里）
//   node infra/ci/isolation-shard.mjs --check-ran <应有的文件数> <会话日志>…
//       不跑，只核对各份日志里实际跑的用例文件数（门禁自测的反例用）
// 要本地的 PostgreSQL 与 Redis 在运行，并给出 DATABASE_URL、REDIS_URL（CLAUDE.md 第 9 节）；packages/db 的用例另要迁移库。
// 退出码：0 通过；1 有一边测试没过、文件数对不上或核对不过；2 用法错误。除 vitest/node（问 Vitest）外不引依赖。

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
/** 核对两份用量记录的脚本：不分片时用的同一个 */
const CHECKER = "packages/services/src/testing/isolation.mjs";
/** 每一片都另带的两份用例（相对仓库根） */
const ANCHORS = [
  "packages/db/src/testing/parallel.test.ts",
  "packages/services/src/testing/redis-isolation.test.ts",
];
const MAX_SESSION_WORKERS = 4;

const say = (line) => process.stdout.write(`${line}\n`);

class UsageError extends Error {}

function parseShard(value) {
  const match = /^([1-9][0-9]?)\/([1-9][0-9]?)$/.exec(value ?? "");
  const shard = match ? { index: Number(match[1]), count: Number(match[2]) } : null;
  if (shard === null || shard.index > shard.count) {
    throw new UsageError("--shard 后面要跟 <第几片>/<共几片>，如 2/4");
  }
  return shard;
}

function parseArgs(args) {
  const options = { shard: null, workers: undefined, keep: false, dryRun: false, list: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--shard") options.shard = parseShard(args[(index += 1)]);
    else if (arg === "--workers") {
      const workers = args[(index += 1)];
      if (!/^[1-9][0-9]?$/.test(workers ?? "")) {
        throw new UsageError("--workers 后面要跟 1–99 的整数");
      }
      options.workers = Number(workers);
    } else throw new UsageError(`不认识的参数 ${arg}`);
  }
  if (!options.list && options.shard === null) {
    throw new UsageError("要给 --shard <第几片>/<共几片>（只列文件时用 --list）");
  }
  return options;
}

/**
 * 问 Vitest：连库的测试项目（挂了 globalSetup 的）有哪些，它们的用例文件有哪些；给了 shard 时只留这一片。
 * 认项目的办法与 isolation.mjs 的 --scope connected 相同；只解析配置、列文件，不执行 globalSetup、不跑用例。
 * 分片用 Vitest 配置里的那个分片器，不在这里另写一遍算法。
 */
async function inspect(shard) {
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", {
    root: repoRoot,
    watch: false,
    ...(shard ? { shard: `${shard.index}/${shard.count}` } : {}),
  });
  try {
    const projects = vitest.projects
      .filter((project) => project.config.globalSetup.length > 0)
      .map((project) => project.name)
      .sort();
    const names = new Set(projects);
    const all = (await vitest.globTestSpecifications()).filter((spec) =>
      names.has(spec.project.name),
    );
    const mine = shard ? await new vitest.config.sequence.sequencer(vitest).shard(all) : all;
    const entry = (spec) => ({
      project: spec.project.name,
      file: relative(repoRoot, spec.moduleId),
    });
    const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    return {
      projects,
      total: all.length,
      known: new Set(all.map((spec) => entry(spec).file)),
      files: mine.map(entry).sort(byFile),
    };
  } finally {
    await vitest.close();
  }
}

/** 跑一遍这一片：输出进日志文件，返回退出码。写法同 isolation.mjs 的 runSession（那边不导出，这里照抄） */
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

/** 日志汇总里“Test Files  …（N）”括号里的总数：这个会话实际跑了几个用例文件；读不出返回 null */
function ranFiles(file) {
  try {
    // 去掉颜色码（ESC 开头的一段）：不在正则里写控制字符
    const text = readFileSync(file, "utf8")
      .split(String.fromCharCode(27))
      .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
      .join("");
    const total = /^\s*Test Files\s.*\((\d+)\)\s*$/m.exec(text)?.[1];
    return total === undefined ? null : Number(total);
  } catch {
    return null;
  }
}

/** 各份日志里实际跑的文件数都要等于 expected；返回问题清单（空 = 对得上） */
function ranProblems(expected, logs) {
  return logs.flatMap(({ label, file }) => {
    const ran = ranFiles(file);
    return ran === expected
      ? []
      : [
          `${label}跑了 ${ran === null ? "不知道几" : ran} 个用例文件，这一片应当是 ${expected} 个：分片对不上`,
        ];
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--check-ran") {
    if (args.length < 3 || !/^[1-9][0-9]*$/.test(args[1])) {
      console.error("测试隔离（分片）：--check-ran 后面要跟应有的文件数与至少一份会话日志");
      return 2;
    }
    const logs = args.slice(2).map((file, index) => ({ label: `第 ${index + 1} 份日志`, file }));
    const problems = ranProblems(Number(args[1]), logs);
    for (const problem of problems) console.error(`  不通过：${problem}`);
    if (problems.length === 0) say(`  ${logs.length} 份日志里都是 ${args[1]} 个用例文件`);
    return problems.length === 0 ? 0 : 1;
  }
  const options = parseArgs(args);
  const info = await inspect(options.shard);
  if (info.projects.length === 0) {
    console.error("测试隔离（分片）：没有哪个测试项目挂了 globalSetup，范围是空的");
    return 1;
  }
  if (options.list) {
    for (const { project, file } of info.files) say(`${project}\t${file}`);
    return 0;
  }
  const { index, count } = options.shard;
  if (info.files.length === 0) {
    console.error(`测试隔离（分片）：第 ${index}/${count} 片里没有用例文件（片数比文件还多）`);
    return 1;
  }
  const lost = ANCHORS.filter((file) => !info.known.has(file));
  if (lost.length > 0) {
    console.error(
      `测试隔离（分片）：每片另带的用例不在范围里了：${lost.join("、")}。改了名或挪了地方，要跟着改 infra/ci/isolation-shard.mjs`,
    );
    return 1;
  }
  const own = info.files.map(({ file }) => file);
  const extra = ANCHORS.filter((file) => !own.includes(file));
  const files = [...own, ...extra];

  const cores = availableParallelism();
  const workers =
    options.workers ?? Math.max(1, Math.min(MAX_SESSION_WORKERS, Math.floor(cores / 2)));
  const projectArgs = info.projects.flatMap((project) => ["--project", project]);
  // 文件给绝对路径：Vitest 对绝对路径按前缀认，不会因为别处有同名的片段多跑
  const vitestArgs = [
    `--maxWorkers=${workers}`,
    ...projectArgs,
    ...files.map((file) => join(repoRoot, file)),
  ];
  const stem = randomBytes(4).toString("hex");
  const sessions = [`s${stem}a`, `s${stem}b`];
  say(
    `测试隔离（分片）：两个会话（${sessions.join("、")}）同时跑连库的测试项目（挂了 globalSetup 的：${info.projects.join("、")}）的第 ${index} 片（共 ${count} 片），各 ${workers} 个 worker（本机可用 ${cores} 核）`,
  );
  say(
    `  这一片 ${own.length} 个用例文件（全部 ${info.total} 个）${extra.length > 0 ? `，另带 ${extra.length} 个：${extra.join("、")}` : "，另带的两份本来就在这一片里"}`,
  );
  say(
    `  每个会话的命令：pnpm test --maxWorkers=${workers} ${projectArgs.join(" ")} <这 ${files.length} 个文件>`,
  );
  if (options.dryRun) return 0;

  const dir = mkdtempSync(join(tmpdir(), "lyx-test-isolation-shard-"));
  const runs = sessions.map((session) => runSession(session, dir, vitestArgs));
  const codes = await Promise.all(runs.map((run) => run.done));

  let ok = true;
  for (const [at, run] of runs.entries()) {
    const code = codes[at];
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
    console.error("测试隔离（分片）：有一边的测试没过，不再核对");
  } else {
    const problems = ranProblems(
      files.length,
      runs.map((run) => ({ label: `会话 ${run.session} `, file: run.logFile })),
    );
    for (const problem of problems) console.error(`  不通过：${problem}`);
    ok = problems.length === 0;
  }
  if (ok) {
    // 核对两份用量记录：交给不分片时用的同一个脚本，口径一字不改
    const check = spawnSync(
      process.execPath,
      [join(repoRoot, CHECKER), "--check", runs[0].usageFile, runs[1].usageFile],
      { cwd: repoRoot, stdio: "inherit" },
    );
    ok = check.status === 0;
  }
  // 通过即删；没过的留着看
  if (ok && !options.keep) rmSync(dir, { recursive: true, force: true });
  else say(`  日志与用量记录留在 ${dir}`);
  return ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`测试隔离（分片）：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
