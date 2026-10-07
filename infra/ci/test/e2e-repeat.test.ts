import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot } from "./helpers.js";

type Round = { status: string; exitCode: number | null; signal: string | null; durationMs: number };
type Summary = {
  requested: number;
  attempted: number;
  passed: number;
  failed: number;
  skipped: number;
  status: string;
  exitCode: number;
  summaryPath: string;
  rounds: ({ session: string; logPath: string } & Round)[];
};
type RoundOptions = {
  session: string;
  logPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
};
const { parseArgs, runRound, runRepeated } = (await import(
  pathToFileURL(join(repoRoot, "infra/ci/e2e-repeat.mjs")).href
)) as {
  parseArgs: (argv: string[]) => { times: number; out: string };
  runRound: (options: RoundOptions) => Promise<Round>;
  runRepeated: (options: {
    times: number;
    out: string;
    signal?: AbortSignal;
    runOnce?: (options: RoundOptions) => Promise<Round>;
  }) => Promise<Summary>;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function temp() {
  const entry = makeTempDir("lyx-m1-repeat-");
  cleanups.push(entry.cleanup);
  return entry.dir;
}
const pass = (): Round => ({ status: "passed", exitCode: 0, signal: null, durationMs: 10 });

describe("连续运行不能把失败重试成十次成功", () => {
  it("十轮顺序运行，各自独立合法会话，保存完整汇总", async () => {
    const seen = new Set<string>();
    let active = 0;
    const summary = await runRepeated({
      times: 10,
      out: temp(),
      runOnce: async ({ session }) => {
        expect(active++).toBe(0);
        expect(session).toMatch(/^[a-z0-9]{1,12}$/);
        expect(seen.has(session)).toBe(false);
        seen.add(session);
        await Promise.resolve();
        active -= 1;
        return pass();
      },
    });
    expect([
      summary.exitCode,
      summary.attempted,
      summary.passed,
      summary.failed,
      summary.skipped,
    ]).toEqual([0, 10, 10, 0, 0]);
    expect(JSON.parse(readFileSync(summary.summaryPath, "utf8")).status).toBe("passed");
  });
  it("第二轮失败停下，不偷偷重试或将少跑算作全绿", async () => {
    let calls = 0;
    const summary = await runRepeated({
      times: 10,
      out: temp(),
      runOnce: async () => (++calls === 2 ? { ...pass(), status: "failed", exitCode: 7 } : pass()),
    });
    expect(calls).toBe(2);
    expect([
      summary.exitCode,
      summary.attempted,
      summary.passed,
      summary.failed,
      summary.skipped,
    ]).toEqual([1, 2, 1, 1, 8]);
    expect(JSON.parse(readFileSync(summary.summaryPath, "utf8")).rounds).toHaveLength(2);
  });
  it("异常与伪成功的超时/非零/信号退出都非零并保部分结果", async () => {
    for (const result of [
      { ...pass(), durationMs: 90_001 },
      { ...pass(), exitCode: 1 },
      { ...pass(), signal: "SIGTERM" },
    ]) {
      const summary = await runRepeated({ times: 10, out: temp(), runOnce: async () => result });
      expect(summary.exitCode).toBe(1);
      expect(summary.failed).toBe(1);
    }
    const summary = await runRepeated({
      times: 10,
      out: temp(),
      runOnce: async () => {
        throw new Error("子进程没启动");
      },
    });
    expect(summary.exitCode).toBe(1);
    expect(readFileSync(summary.summaryPath, "utf8")).toContain("子进程没启动");
  });
  it("中断保存已做轮数，SIGINT 按 130 退出", async () => {
    const controller = new AbortController();
    const summary = await runRepeated({
      times: 10,
      out: temp(),
      signal: controller.signal,
      runOnce: async () => {
        controller.abort("SIGINT");
        return { ...pass(), status: "aborted" };
      },
    });
    expect([summary.exitCode, summary.attempted, summary.failed, summary.skipped]).toEqual([
      130, 1, 1, 9,
    ]);
    expect(JSON.parse(readFileSync(summary.summaryPath, "utf8")).status).toBe("aborted");
  });
  it("真实子进程超时后被收回，日志保存", async () => {
    const logPath = join(temp(), "timeout.log");
    const result = await runRound({
      session: "rtimeout1",
      logPath,
      timeoutMs: 200,
      spawnProcess: ((_command: string, _args: readonly string[], options: SpawnOptions) =>
        spawn(
          process.execPath,
          ["-e", "process.stdout.write('started'); setInterval(() => {}, 1000)"],
          options,
        )) as typeof spawn,
    });
    expect(result.status).toBe("timeout");
    expect(result.signal).toBe("SIGTERM");
    expect(readFileSync(logPath, "utf8")).toContain("started");
    expect(result.durationMs).toBeLessThan(5_000);
  });
  it("父进程退出也收回忽略 TERM 且不持有管道的本轮子孙", async () => {
    const logPath = join(temp(), "descendant.log");
    let group: number | undefined;
    const childCode = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    const parentCode = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio: 'ignore'}); process.stdout.write(String(child.pid)); setInterval(() => {}, 1000)`;
    try {
      const result = await runRound({
        session: "rdescendant",
        logPath,
        timeoutMs: 500,
        spawnProcess: ((_command: string, _args: readonly string[], options: SpawnOptions) => {
          const child = spawn(process.execPath, ["-e", parentCode], options);
          group = child.pid;
          return child;
        }) as typeof spawn,
      });
      expect(result.status).toBe("timeout");
      const pid = Number(readFileSync(logPath, "utf8"));
      expect(pid).toBeGreaterThan(0);
      const state = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
      // Linux 收养后的短暂 zombie 已终止；不允许仍存活的睡眠/运行进程。
      expect(state.stdout.trim() === "" || state.stdout.trim().startsWith("Z")).toBe(true);
    } finally {
      if (group) {
        try {
          process.kill(-group, "SIGKILL");
        } catch (err) {
          expect((err as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      }
    }
  });
  it("真实子进程只能调用 pnpm e2e，覆盖传入会话且 APP_ENV=test", async () => {
    const logPath = join(temp(), "pass.log");
    const result = await runRound({
      session: "rowned1",
      logPath,
      spawnProcess: ((command: string, args: readonly string[], options: SpawnOptions) => {
        expect([command, args]).toEqual(["pnpm", ["e2e"]]);
        expect(options?.env?.LYX_TEST_SESSION).toBe("rowned1");
        expect(options?.env?.APP_ENV).toBe("test");
        expect(options?.detached).toBe(process.platform !== "win32");
        return spawn(process.execPath, ["-e", "process.stdout.write('real child green')"], options);
      }) as typeof spawn,
    });
    expect(result.status).toBe("passed");
    expect(readFileSync(logPath, "utf8")).toContain("real child green");
  });
  it("非法次数、未知或重复参数不能成为零次通过或命令覆盖", () => {
    for (const args of [
      ["--times", "0"],
      ["--times", "1.5"],
      ["--times", "101"],
      ["--times", "10", "--times", "1"],
      ["--command", "true"],
      ["--out"],
    ])
      expect(() => parseArgs(args)).toThrow();
    expect(parseArgs([]).times).toBe(10);
  });
});
