#!/usr/bin/env node
// W1-21：每轮独立测试会话、顺序运行真实 pnpm e2e；失败不重试，部分结果始终保存。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const ROUND_TIMEOUT_MS = 90_000;
const DEFAULT_OUT = join(repoRoot, "apps/api/dist/e2e-repeat");

export function parseArgs(argv) {
  const options = { times: 10, out: DEFAULT_OUT };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--times", "--out"].includes(flag) || seen.has(flag) || !value)
      throw new Error(`参数无效：${flag}（用法：--times 1..100 --out <产物目录>）`);
    seen.add(flag);
    if (flag === "--times") {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 100)
        throw new Error("--times 必须是 1–100 的整数");
      options.times = Number(value);
    } else options.out = resolve(value);
  }
  return options;
}

/** 具名接口链共用执行器；M1默认命令与90秒上限保持，CLI不接受命令覆盖。 */
export function runRound({
  session,
  logPath,
  signal,
  timeoutMs = ROUND_TIMEOUT_MS,
  spawnProcess = spawn,
  script = "e2e",
}) {
  if (
    !["e2e", "e2e:m2", "e2e:m3"].includes(script) ||
    !/^[a-z0-9]{1,12}$/.test(session) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > ROUND_TIMEOUT_MS
  )
    throw new Error("测试会话或单轮时限无效");
  const start = performance.now();
  return new Promise((resolveRound, reject) => {
    const log = createWriteStream(logPath, { flags: "wx" });
    let child;
    let stopStatus;
    let error;
    let deadline;
    let forceKill;
    let finished = false;
    const kill = (kind) => {
      if (!child?.pid) return;
      try {
        // 一个独立进程组包含 pnpm、Vitest 与其子进程；只终止本轮拥有的组。
        if (process.platform === "win32") child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch (err) {
        if (err.code !== "ESRCH") error = err.message;
      }
    };
    const stop = (status) => {
      if (finished || stopStatus) return;
      stopStatus = status;
      kill("SIGTERM");
      forceKill = setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const aborted = () => stop("aborted");
    log.once("error", (err) => {
      error = err.message;
      stop("failed");
      if (!child) reject(err);
    });
    if (signal?.aborted) {
      finished = true;
      log.end("运行在启动前中断\n", () =>
        resolveRound({
          status: "aborted",
          exitCode: null,
          signal: null,
          durationMs: performance.now() - start,
        }),
      );
      return;
    }
    child = spawnProcess("pnpm", [script], {
      cwd: repoRoot,
      env: { ...process.env, APP_ENV: "test", LYX_TEST_SESSION: session },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream?.pipe(log, { end: false });
    signal?.addEventListener("abort", aborted, { once: true });
    deadline = setTimeout(() => stop("timeout"), timeoutMs);
    child.once("error", (err) => {
      error = err.message;
    });
    child.once("close", (exitCode, childSignal) => {
      finished = true;
      clearTimeout(deadline);
      // 父进程已退出时，仍收回不持有管道、忽略 TERM 的本轮子孙；不能直接取消 KILL。
      if (stopStatus) kill("SIGKILL");
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", aborted);
      const durationMs = performance.now() - start;
      const status =
        stopStatus ??
        (error || exitCode !== 0 ? "failed" : durationMs > timeoutMs ? "timeout" : "passed");
      const result = {
        status,
        exitCode,
        signal: childSignal,
        durationMs,
        ...(error ? { error } : {}),
      };
      if (log.destroyed) reject(new Error(error ?? "日志写入失败"));
      else log.end(() => resolveRound(result));
    });
    // signal 可在检查与事件绑定之间中断。
    if (signal?.aborted) aborted();
  });
}

export async function runRepeated({
  times = 10,
  out = DEFAULT_OUT,
  signal,
  runOnce = runRound,
  report = () => {},
}) {
  if (!Number.isInteger(times) || times < 1 || times > 100)
    throw new Error("次数必须是 1–100 的整数");
  const prefix = `r${randomBytes(4).toString("hex")}`;
  const artifactDir = join(out, `run-${prefix}`);
  mkdirSync(artifactDir, { recursive: true });
  const summaryPath = join(artifactDir, "summary.json");
  const start = performance.now();
  const summary = {
    schemaVersion: 1,
    requested: times,
    attempted: 0,
    passed: 0,
    failed: 0,
    skipped: times,
    status: "running",
    totalDurationMs: 0,
    rounds: [],
    summaryPath,
  };
  const save = () => {
    summary.totalDurationMs = performance.now() - start;
    writeFileSync(`${summaryPath}.tmp`, `${JSON.stringify(summary, null, 2)}\n`);
    renameSync(`${summaryPath}.tmp`, summaryPath);
  };
  save();
  for (let index = 1; index <= times && !signal?.aborted; index += 1) {
    const session = `${prefix}${index.toString(36)}`;
    const logPath = join(artifactDir, `round-${index}.log`);
    let result;
    const roundStart = performance.now();
    try {
      result = await runOnce({ session, logPath, signal });
    } catch (err) {
      result = {
        status: "failed",
        exitCode: null,
        signal: null,
        durationMs: performance.now() - roundStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // 注入 runner 也不能把超时、信号或异常退出报成成功。
    if (
      result.status === "passed" &&
      (result.exitCode !== 0 ||
        result.signal !== null ||
        !Number.isFinite(result.durationMs) ||
        result.durationMs < 0 ||
        result.durationMs > ROUND_TIMEOUT_MS)
    )
      result = { ...result, status: "failed" };
    summary.rounds.push({ index, session, logPath, ...result });
    summary.attempted += 1;
    summary[result.status === "passed" ? "passed" : "failed"] += 1;
    summary.skipped = times - summary.attempted;
    save();
    report(
      `第 ${index}/${times} 轮：${result.status}，${Math.round(result.durationMs)}ms；${logPath}`,
    );
    if (result.status !== "passed") break;
  }
  summary.status = signal?.aborted ? "aborted" : summary.passed === times ? "passed" : "failed";
  summary.exitCode =
    summary.status === "passed"
      ? 0
      : signal?.reason === "SIGINT"
        ? 130
        : signal?.reason === "SIGTERM"
          ? 143
          : 1;
  save();
  return summary;
}

export async function runRepeatCli({
  label = "M1",
  parse = parseArgs,
  run = runRepeated,
  argv = process.argv.slice(2),
} = {}) {
  let options;
  try {
    options = parse(argv);
  } catch (err) {
    console.error(`${label} 连续运行：${err.message}`);
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const onInt = () => controller.abort("SIGINT");
  const onTerm = () => controller.abort("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    const result = await run({
      ...options,
      signal: controller.signal,
      report: console.log,
    });
    const message = `${result.attempted}/${result.requested} 轮已尝试，成功 ${result.passed}，失败 ${result.failed}，未执行 ${result.skipped}；${result.summaryPath}`;
    if (result.exitCode === 0) console.log(`${label} 连续运行通过：${message}`);
    else console.error(`${label} 连续运行未通过：${message}`);
    process.exitCode = result.exitCode;
  } catch (err) {
    console.error(`${label} 连续运行未完成：${err.message}`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runRepeatCli();
