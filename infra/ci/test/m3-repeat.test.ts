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
  signal?: AbortSignal;
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
  rounds: ({ session: string } & Round)[];
};
const loadRepeatModule = (name: string) =>
  import(pathToFileURL(join(repoRoot, "infra/ci", name)).href);
const { parseM3Args, runM3Round, runM3Repeated } = (await loadRepeatModule("m3-repeat.mjs")) as {
  parseM3Args(argv: string[]): { times: number; out: string };
  runM3Round(input: RoundInput): Promise<Round>;
  runM3Repeated(input: {
    times: number;
    out: string;
    runOnce?: (input: RoundInput) => Promise<Round>;
  }): Promise<Summary>;
};
const { runRound } = (await loadRepeatModule("e2e-repeat.mjs")) as {
  runRound(input: RoundInput): Promise<Round>;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
const temp = () => {
  const entry = makeTempDir("lyx-m3-repeat-");
  cleanups.push(entry.cleanup);
  return entry.dir;
};
const pass = (): Round => ({ status: "passed", exitCode: 0, signal: null, durationMs: 1 });

it("M3固定真实脚本与隔离环境且自然退出，M1默认和既有CI出口保持", async () => {
  const directory = temp();
  for (const target of ["e2e", "e2e:m3"]) {
    const execute = target === "e2e" ? runRound : runM3Round;
    const result = await execute({
      session: "m3target1",
      logPath: join(directory, `${target.replace(":", "-")}.log`),
      // The M3 adapter must override even a caller-provided M1 target.
      ...(target === "e2e:m3" ? { script: "e2e" } : {}),
      spawnProcess: ((command: string, args: readonly string[], options: SpawnOptions) => {
        expect([command, args]).toEqual(["pnpm", [target]]);
        expect(options.env?.APP_ENV).toBe("test");
        expect(options.env?.LYX_TEST_SESSION).toBe("m3target1");
        return spawn(process.execPath, ["-e", "process.stdout.write('natural close')"], options);
      }) as typeof spawn,
    });
    expect(result).toMatchObject({ status: "passed", exitCode: 0, signal: null });
  }
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(packageJson.scripts["e2e:m3"]).toBe(
    "pnpm exec vitest run --project api apps/api/test/e2e/m3.e2e.test.ts",
  );
  expect(packageJson.scripts["demo:m3"]).toBe(
    "pnpm --filter @liyoxi/services exec tsx ../../apps/api/test/e2e/demo-m3.ts",
  );
  const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
    repeat = readFileSync(join(repoRoot, ".github/workflows/e2e-repeat.yml"), "utf8");
  for (const command of [
    "pnpm e2e",
    "pnpm e2e:m3",
    "node infra/ci/landed.mjs --check --require M0,M1",
    "node infra/ci/landed.mjs --check --require M0,M1,M3",
    "node infra/ci/four-counts.mjs --require M0,M1",
    "node infra/ci/four-counts.mjs --require M0,M1,M3",
  ])
    expect(
      ci.split("\n").some((line) => line.trim() === `run: ${command}`),
      command,
    ).toBe(true);
  expect(repeat).toContain("needs: m1-repeat");
  expect(repeat).toContain("run: node infra/ci/e2e-repeat.mjs --times 10");
  expect(repeat).toContain("run: node infra/ci/m3-repeat.mjs --times 10");
  expect(repeat).toMatch(/保存 M3 连续运行结果\n\s+if: always\(\)/);
});

it("M3十轮顺序独立会话复用原汇总，第二轮失败不重试并保留未执行数", async () => {
  const sessions = new Set<string>();
  let active = false;
  const summary = await runM3Repeated({
    times: 10,
    out: temp(),
    runOnce: async ({ session }) => {
      expect(active).toBe(false);
      active = true;
      expect(session).toMatch(/^[a-z0-9]{1,12}$/);
      expect(sessions.has(session)).toBe(false);
      sessions.add(session);
      await Promise.resolve();
      active = false;
      return pass();
    },
  });
  expect(summary).toMatchObject({ attempted: 10, passed: 10, failed: 0, skipped: 0, exitCode: 0 });
  expect(JSON.parse(readFileSync(summary.summaryPath, "utf8")).rounds).toHaveLength(10);
  let calls = 0;
  const failed = await runM3Repeated({
    times: 10,
    out: temp(),
    runOnce: async () => (++calls === 2 ? { ...pass(), status: "failed", exitCode: 7 } : pass()),
  });
  expect(calls).toBe(2);
  expect(failed).toMatchObject({ attempted: 2, passed: 1, failed: 1, skipped: 8, exitCode: 1 });
  expect(JSON.parse(readFileSync(failed.summaryPath, "utf8")).status).toBe("failed");
});

it("M3超时非零或信号都不能伪绿，CLI不接受命令覆盖且报告目录与M1隔离", async () => {
  for (const result of [
    { ...pass(), durationMs: 90_001 },
    { ...pass(), exitCode: 9 },
    { ...pass(), signal: "SIGTERM" },
  ]) {
    const summary = await runM3Repeated({ times: 10, out: temp(), runOnce: async () => result });
    expect(summary).toMatchObject({ attempted: 1, failed: 1, skipped: 9, exitCode: 1 });
  }
  for (const args of [
    ["--command", "true"],
    ["--script", "e2e"],
    ["--times", "0"],
  ])
    expect(() => parseM3Args(args)).toThrow();
  expect(parseM3Args([])).toMatchObject({ times: 10 });
  expect(parseM3Args([]).out).toBe(join(repoRoot, "apps/api/dist/m3-e2e-repeat"));
  expect(parseM3Args(["--out", temp()]).out).not.toBe(parseM3Args([]).out);
  expect(() =>
    runRound({ session: "m3bad1", logPath: join(temp(), "bad.log"), script: "true" }),
  ).toThrow();
});
