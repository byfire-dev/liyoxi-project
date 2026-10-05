import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run, writeFiles } from "./helpers.js";

// 测试隔离的全量分片跑（infra/ci/isolation-shard.mjs）：必过检查里 test-isolation 与它的另三片各跑一片。
// 钉在这里：范围与不分片的那一遍（pnpm test:isolation --scope connected）相同；各片互不重叠、合起来是全部；
// 每片另带的两份用例都在；实际跑的文件数对不上即失败。真起两个会话跑一片太重，不在用例里跑（CI 的四个任务就是实跑）。

const SCRIPT = join(repoRoot, "infra/ci/isolation-shard.mjs");
const WHOLE = join(repoRoot, "packages/services/src/testing/isolation.mjs");
const SHARDS = 4;
const ANCHORS = [
  "packages/db/src/testing/parallel.test.ts",
  "packages/services/src/testing/redis-isolation.test.ts",
];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const shard = (...args: string[]) => run(process.execPath, [SCRIPT, ...args], repoRoot);
// 每问一次都要起一遍 Vitest 列文件：同一份名单只问一次
const lists = new Map<string, string[]>();
function listed(...args: string[]): string[] {
  const key = args.join(" ");
  let lines = lists.get(key);
  if (lines === undefined) {
    const result = shard("--list", ...args);
    expect(result.status, result.output).toBe(0);
    lines = result.stdout.split("\n").filter((line) => line.includes("\t"));
    lists.set(key, lines);
  }
  return lines;
}
const part = (index: number) => listed("--shard", `${index}/${SHARDS}`);
const fileOf = (line: string) => line.split("\t")[1] ?? "";

describe("范围：与不分片的那一遍相同", () => {
  it("项目是 --scope connected 认的那几个（挂了 globalSetup 的），文件是这几个项目的全部用例文件", () => {
    const whole = run(process.execPath, [WHOLE, "--scope", "connected", "--dry-run"], repoRoot);
    expect(whole.status, whole.output).toBe(0);
    const command = /每个会话的命令：pnpm test (.+)/.exec(whole.stdout)?.[1] ?? "";
    const projects = [...command.matchAll(/--project (\S+)/g)].map((match) => match[1] ?? "");
    expect(projects.length).toBeGreaterThan(0);

    const all = listed();
    expect([...new Set(all.map((line) => line.split("\t")[0]))].sort()).toEqual(
      [...projects].sort(),
    );
    // 这几个项目的全部用例文件：问 Vitest 自己（与不分片时跑的是同一批）
    const vitest = run(
      "pnpm",
      [
        "exec",
        "vitest",
        "list",
        "--filesOnly",
        ...projects.flatMap((project) => ["--project", project]),
      ],
      repoRoot,
    );
    expect(vitest.status, vitest.output).toBe(0);
    const expected = [...vitest.stdout.matchAll(/^\[([\w-]+)\] (\S+)$/gm)].map(
      (match) => `${match[1]}\t${match[2]}`,
    );
    expect(expected.length).toBeGreaterThan(SHARDS);
    expect([...all].sort()).toEqual(expected.sort());
  });
});

describe("分法：互不重叠，合起来是全部", () => {
  it("四片的并集等于全部，没有哪个文件出现两次；各片的文件数最多差一个", () => {
    const all = listed();
    const parts = Array.from({ length: SHARDS }, (_, at) => part(at + 1));
    expect(parts.flat().sort()).toEqual([...all].sort());
    expect(new Set(parts.flat()).size).toBe(all.length);
    const sizes = parts.map((files) => files.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("另带的两份用例都在范围里，各恰好属于一片", () => {
    const parts = Array.from({ length: SHARDS }, (_, at) => part(at + 1).map(fileOf));
    for (const anchor of ANCHORS) {
      expect(listed().map(fileOf)).toContain(anchor);
      expect(parts.filter((files) => files.includes(anchor))).toHaveLength(1);
    }
  });
});

describe("每一片怎么跑", () => {
  it("两个会话跑同一条命令：这一片的文件，加上不在这一片里的那几份另带的；项目与不分片时相同", () => {
    // 只看一片：每多问一次都要再起一遍 Vitest
    for (const index of [1]) {
      const own = part(index).map(fileOf);
      const extra = ANCHORS.filter((anchor) => !own.includes(anchor));
      const result = shard("--shard", `${index}/${SHARDS}`, "--workers", "1", "--dry-run");
      expect(result.status, result.output).toBe(0);
      expect(result.stdout).toContain(`的第 ${index} 片（共 ${SHARDS} 片），各 1 个 worker`);
      expect(result.stdout).toContain(
        `这一片 ${own.length} 个用例文件（全部 ${listed().length} 个）`,
      );
      for (const anchor of extra) expect(result.stdout).toContain(anchor);
      expect(result.stdout).toMatch(
        new RegExp(
          `每个会话的命令：pnpm test --maxWorkers=1 (--project \\S+ )+<这 ${own.length + extra.length} 个文件>`,
        ),
      );
      const sessions = /两个会话（(\w+)、(\w+)）/.exec(result.stdout);
      expect(sessions?.[1]).not.toBe(sessions?.[2]);
    }
  });

  it("核对交给不分片时用的同一个脚本；用量记录、会话标识的环境变量也是同一组", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain('const CHECKER = "packages/services/src/testing/isolation.mjs";');
    expect(script).toContain(
      '[join(repoRoot, CHECKER), "--check", runs[0].usageFile, runs[1].usageFile]',
    );
    expect(script).toContain("LYX_TEST_SESSION: session, LYX_TEST_USAGE_FILE: usageFile");
    const whole = readFileSync(WHOLE, "utf8");
    expect(whole).toContain("LYX_TEST_SESSION: session, LYX_TEST_USAGE_FILE: usageFile");
  });
});

describe("实际跑的文件数对不上即失败（--check-ran）", () => {
  const log = (files: number, total = files) =>
    `\n Test Files  ${files} passed (${total})\n      Tests  486 passed (486)\n   Duration  104.62s\n`;
  function logs(contents: Record<string, string>) {
    const temp = makeTempDir("lyx-isolation-shard-");
    cleanups.push(temp.cleanup);
    writeFiles(temp.dir, contents);
    return Object.keys(contents).map((name) => join(temp.dir, name));
  }

  it("两份日志都是应有的个数：通过；带颜色码、有跳过的文件也读得出括号里的总数", () => {
    const plain = logs({ "a.log": log(33), "b.log": log(33) });
    expect(shard("--check-ran", "33", ...plain).status).toBe(0);
    const esc = String.fromCharCode(27);
    const fancy = logs({
      "a.log": `\n${esc}[2m Test Files ${esc}[22m ${esc}[1m${esc}[32m32 passed${esc}[39m${esc}[22m${esc}[2m | ${esc}[22m${esc}[33m1 skipped${esc}[39m${esc}[90m (33)${esc}[39m\n`,
    });
    expect(shard("--check-ran", "33", ...fancy).status).toBe(0);
  });

  it("有一份少跑了、多跑了、读不出个数：失败并指出是哪一份", () => {
    const fewer = shard("--check-ran", "33", ...logs({ "a.log": log(33), "b.log": log(32) }));
    expect(fewer.status).toBe(1);
    expect(fewer.stderr).toContain("第 2 份日志跑了 32 个用例文件，这一片应当是 33 个：分片对不上");
    expect(fewer.stderr).not.toContain("第 1 份日志");
    expect(shard("--check-ran", "33", ...logs({ "a.log": log(34) })).status).toBe(1);
    const unreadable = shard("--check-ran", "33", ...logs({ "a.log": "没有汇总\n" }));
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain("跑了 不知道几 个用例文件");
    expect(shard("--check-ran", "33", "/no/such.log").status).toBe(1);
  });
});

describe("用法", () => {
  it("不给 --shard、片号写错、不认识的参数：退出码 2；这个脚本没有缩范围的参数", () => {
    for (const args of [
      [],
      ["--shard"],
      ["--shard", "2"],
      ["--shard", "0/4"],
      ["--shard", "5/4"],
      ["--shard", "1/4", "--scope", "all"],
      ["--shard", "1/4", "--project", "db"],
      ["--shard", "1/4", "--workers", "0"],
      ["--check-ran", "33"],
      ["--check-ran", "三十三", "a.log"],
    ]) {
      expect(shard(...args).status, args.join(" ")).toBe(2);
    }
  });
});
