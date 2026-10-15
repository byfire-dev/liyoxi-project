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
  script?: string;
  spawnProcess?: typeof spawn;
};
type Summary = {
  attempted: number;
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
  summaryPath: string;
};
const { parseM2Args, runM2Round, runM2Repeated } = (await import(
  pathToFileURL(join(repoRoot, "infra/ci/m2-repeat.mjs")).href
)) as {
  parseM2Args(args: string[]): { times: number; out: string };
  runM2Round(input: RoundInput): Promise<Round>;
  runM2Repeated(input: {
    times: number;
    out: string;
    runOnce: (input: RoundInput) => Promise<Round>;
  }): Promise<Summary>;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function temp() {
  const entry = makeTempDir("lyx-m2-repeat-");
  cleanups.push(entry.cleanup);
  return entry.dir;
}
const pass = (): Round => ({ status: "passed", exitCode: 0, signal: null, durationMs: 1 });

it("M2只执行固定真实入口，独立会话及CI串行依赖、失败产物保持", async () => {
  const result = await runM2Round({
    session: "m2target1",
    logPath: join(temp(), "round.log"),
    script: "e2e:m3",
    spawnProcess: ((command: string, args: readonly string[], options: SpawnOptions) => {
      expect([command, args]).toEqual(["pnpm", ["e2e:m2"]]);
      expect(options.env?.APP_ENV).toBe("test");
      expect(options.env?.LYX_TEST_SESSION).toBe("m2target1");
      return spawn(process.execPath, ["-e", "process.stdout.write('natural close')"], options);
    }) as typeof spawn,
  });
  expect(result).toMatchObject({ status: "passed", exitCode: 0, signal: null });
  const workflow = readFileSync(join(repoRoot, ".github/workflows/e2e-repeat.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("\n  m2-repeat:\n"));
  for (const command of [
    "needs: m3-repeat",
    "always() && !cancelled()",
    "needs.m3-repeat.result == 'success'",
    "needs.m3-repeat.result == 'skipped'",
    "startsWith(github.ref, 'refs/heads/codex/')",
    "timeout-minutes: 25",
    "persist-credentials: false",
    "pnpm install --frozen-lockfile",
    "pnpm db:generate",
    "up -d --wait postgres redis",
    "APP_ENV: test",
    "node infra/ci/m2-repeat.mjs --times 10",
    "if: always()",
    "path: apps/api/dist/m2-e2e-repeat/",
    "if-no-files-found: error",
    "retention-days: 30",
  ])
    expect(job).toContain(command);
  expect(job).not.toMatch(/continue-on-error|\|\| true|secrets\.|: write|--times (?:[1-9])\s*$/m);
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).toContain("run: node infra/ci/e2e-repeat.mjs --times 10");
  expect(workflow).toContain("run: node infra/ci/m3-repeat.mjs --times 10");
});

it("十轮串行且会话独立，遇红即停、超时不得伪绿，CLI不接受任意命令", async () => {
  const sessions = new Set<string>();
  let active = false;
  const summary = await runM2Repeated({
    times: 10,
    out: temp(),
    runOnce: async ({ session }) => {
      expect(active).toBe(false);
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
  const failed = await runM2Repeated({
    times: 10,
    out: temp(),
    runOnce: async () => (++calls === 2 ? { ...pass(), status: "failed", exitCode: 7 } : pass()),
  });
  expect(failed).toMatchObject({ attempted: 2, passed: 1, failed: 1, skipped: 8, exitCode: 1 });
  for (const result of [
    { ...pass(), durationMs: 90_001 },
    { ...pass(), exitCode: 9 },
    { ...pass(), signal: "SIGTERM" },
  ]) {
    expect(
      await runM2Repeated({ times: 10, out: temp(), runOnce: async () => result }),
    ).toMatchObject({ attempted: 1, failed: 1, skipped: 9, exitCode: 1 });
  }
  for (const args of [
    ["--command", "true"],
    ["--script", "e2e"],
    ["--times", "0"],
  ])
    expect(() => parseM2Args(args)).toThrow();
  expect(parseM2Args([])).toEqual({
    times: 10,
    out: join(repoRoot, "apps/api/dist/m2-e2e-repeat"),
  });
});

it("正式demo在十连成功后必跑且失败不能跳过，结果仍由always保存", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/e2e-repeat.yml"), "utf8");
  const expected = [
    "      - name: M2 正式演示 CLI",
    "        timeout-minutes: 2",
    "        run: pnpm demo:m2",
  ].join("\n");
  const valid = (source: string) => {
    const job = source.slice(source.indexOf("\n  m2-repeat:\n"));
    const steps = job.split(/(?=^ {6}- name: )/m);
    const demo = steps.findIndex((step) => step.startsWith("      - name: M2 正式演示 CLI\n"));
    return (
      demo > 0 &&
      steps.filter((step) => step.includes("run: pnpm demo:m2")).length === 1 &&
      steps[demo]?.trimEnd() === expected &&
      steps[demo - 1]?.includes("run: node infra/ci/m2-repeat.mjs --times 10") === true &&
      steps[demo + 1]?.startsWith("      - name: 保存 M2 连续运行结果\n        if: always()") ===
        true
    );
  };
  expect(valid(workflow)).toBe(true);
  for (const changed of [
    workflow.replace(`${expected}\n`, ""),
    workflow.replace(
      expected,
      expected.replace("        run:", "        if: always()\n        run:"),
    ),
    workflow.replace(expected, expected.replace("pnpm demo:m2", "pnpm demo:m2 || true")),
    workflow.replace(expected, expected.replace("timeout-minutes: 2", "timeout-minutes: 3")),
  ])
    expect(valid(changed)).toBe(false);
});
