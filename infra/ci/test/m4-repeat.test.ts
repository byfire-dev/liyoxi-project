import { spawn, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers.js";

type Round = { status: string; exitCode: number | null; signal: string | null; durationMs: number };
type RoundInput = {
  session: string;
  logPath: string;
  timeoutMs?: number;
  script?: string;
  spawnProcess?: typeof spawn;
};
type Summary = {
  attempted: number;
  passed: number;
  failed: number;
  skipped: number;
  status: string;
  exitCode: number;
  summaryPath: string;
};
type RoundRunner = (input: RoundInput) => Promise<Round>;
const load = (name: string) => import(pathToFileURL(join(repoRoot, "infra/ci", name)).href);
const { parseM4Args, runM4Round, runM4Repeated } = (await load("m4-repeat.mjs")) as {
  parseM4Args(argv: string[]): { times: number; out: string };
  runM4Round: RoundRunner;
  runM4Repeated(input: { times: number; out: string; runOnce: RoundRunner }): Promise<Summary>;
};
const { runRound } = (await load("e2e-repeat.mjs")) as { runRound: RoundRunner };
const { runM2Round } = (await load("m2-repeat.mjs")) as { runM2Round: RoundRunner };
const { runM3Round } = (await load("m3-repeat.mjs")) as { runM3Round: RoundRunner };
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
const temp = () => {
  const entry = makeTempDir("lyx-m4-repeat-");
  cleanups.push(entry.cleanup);
  return entry.dir;
};
const pass = (): Round => ({ status: "passed", exitCode: 0, signal: null, durationMs: 1 });

it("M4固定真实脚本不可覆盖，M1/2/3入口与单轮隔离日志自然收尾保留", async () => {
  const directory = temp();
  for (const [target, execute] of [
    ["e2e", runRound],
    ["e2e:m2", runM2Round],
    ["e2e:m3", runM3Round],
    ["e2e:m4", runM4Round],
  ] as const) {
    const logPath = join(directory, `${target.replace(":", "-")}.log`);
    const result = await execute({
      session: "m4target1",
      logPath,
      ...(target === "e2e:m4" ? { script: "e2e:m2" } : {}),
      spawnProcess: ((command: string, args: readonly string[], options: SpawnOptions) => {
        expect([command, args]).toEqual(["pnpm", [target]]);
        expect(options.env?.APP_ENV).toBe("test");
        expect(options.env?.LYX_TEST_SESSION).toBe("m4target1");
        return spawn(process.execPath, ["-e", "process.stdout.write('natural close')"], options);
      }) as typeof spawn,
    });
    expect(result).toMatchObject({ status: "passed", exitCode: 0, signal: null });
    expect(readFileSync(logPath, "utf8")).toBe("natural close");
  }
  const workflow = readFileSync(join(repoRoot, ".github/workflows/e2e-repeat.yml"), "utf8");
  const job = (name: string) => workflow.split(`  ${name}:\n`)[1]?.split(/\n {2}[a-z0-9-]+:\n/)[0];
  expect(job("m1-repeat")).toContain("if: github.ref == 'refs/heads/main'");
  expect(job("m1-repeat")).toContain("run: node infra/ci/e2e-repeat.mjs --times 10");
  expect(job("m3-repeat")).toContain("needs: m1-repeat");
  expect(job("m3-repeat")).toContain("if: github.ref == 'refs/heads/main'");
  expect(job("m3-repeat")).toContain("run: node infra/ci/m3-repeat.mjs --times 10");
  expect(job("m2-repeat")).toContain("needs: m3-repeat");
  expect(job("m2-repeat")).toContain(
    "if: always() && !cancelled() && ((github.ref == 'refs/heads/main' && needs.m3-repeat.result == 'success') || (startsWith(github.ref, 'refs/heads/codex/') && needs.m3-repeat.result == 'skipped'))",
  );
  expect(job("m2-repeat")).toContain("run: node infra/ci/m2-repeat.mjs --times 10");
  const m4 = job("m4-repeat");
  for (const required of [
    "needs: m2-repeat",
    "if: always() && !cancelled() && needs.m2-repeat.result == 'success' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/codex/'))",
    "timeout-minutes: 25",
    "persist-credentials: false",
    "pnpm install --frozen-lockfile",
    "pnpm db:generate",
    "up -d --wait postgres redis",
    "APP_ENV: test",
    "run: node infra/ci/m4-repeat.mjs --times 10",
    "if: always()",
    "path: apps/api/dist/m4-e2e-repeat/",
    "if-no-files-found: error",
    "retention-days: 30",
  ])
    expect(m4).toContain(required);
  expect(m4).not.toMatch(/continue-on-error|\|\| true|secrets\.|: write/);
});

it("M4十轮独立会话严格顺序，第二轮失败即停且摘要保留八轮未执行", async () => {
  const sessions = new Set<string>();
  let active = false;
  const summary = await runM4Repeated({
    times: 10,
    out: temp(),
    runOnce: async ({ session }) => {
      expect(active).toBe(false);
      expect(session).toMatch(/^[a-z0-9]{1,12}$/);
      expect(sessions.has(session)).toBe(false);
      sessions.add(session);
      active = true;
      await Promise.resolve();
      active = false;
      return pass();
    },
  });
  expect(summary).toMatchObject({ attempted: 10, passed: 10, failed: 0, skipped: 0, exitCode: 0 });
  expect(JSON.parse(readFileSync(summary.summaryPath, "utf8")).rounds).toHaveLength(10);
  let calls = 0;
  const failed = await runM4Repeated({
    times: 10,
    out: temp(),
    runOnce: async () => (++calls === 2 ? { ...pass(), status: "failed", exitCode: 7 } : pass()),
  });
  expect(calls).toBe(2);
  expect(failed).toMatchObject({ attempted: 2, passed: 1, failed: 1, skipped: 8, exitCode: 1 });
  expect(JSON.parse(readFileSync(failed.summaryPath, "utf8"))).toMatchObject({
    status: "failed",
    rounds: [
      expect.objectContaining({ status: "passed" }),
      expect.objectContaining({ status: "failed" }),
    ],
  });
});

it("M4沿原90秒上限拒绝超时非零和信号伪绿，CLI不接受脚本覆盖", async () => {
  for (const result of [
    { ...pass(), durationMs: 90_001 },
    { ...pass(), exitCode: 9 },
    { ...pass(), signal: "SIGTERM" },
  ])
    expect(
      await runM4Repeated({ times: 10, out: temp(), runOnce: async () => result }),
    ).toMatchObject({ attempted: 1, failed: 1, skipped: 9, exitCode: 1 });
  for (const args of [
    ["--command", "true"],
    ["--script", "e2e"],
    ["--times", "0"],
  ])
    expect(() => parseM4Args(args)).toThrow();
  expect(parseM4Args([])).toEqual({
    times: 10,
    out: join(repoRoot, "apps/api/dist/m4-e2e-repeat"),
  });
  expect(parseM4Args(["--out", temp()]).out).not.toBe(parseM4Args([]).out);
  expect(() =>
    runM4Round({ session: "m4bad1", logPath: join(temp(), "bad.log"), timeoutMs: 90_001 }),
  ).toThrow();
});
