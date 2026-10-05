import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

// 连库、连 Redis、起子进程的用例：实例忙的时候（别的会话同时在跑）会慢，时限放宽，不用缺省的 5 秒
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// pnpm test:isolation 的核对部分（isolation.mjs --check）：两份用量记录有交集、缺东西，都要判不通过。
// 另验它怎么定范围与并行数（--dry-run：只打印要跑什么，不跑）。
// 整条命令（真的起两个会话跑测试）在 CI 的 test:isolation 一步里跑（带 --scope connected），这里不嵌套着再跑一遍。

const SCRIPT = fileURLToPath(new URL("./isolation.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "lyx-isolation-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Usage {
  databases: string[];
  redis: string[];
  parallel?: string[];
}

let serial = 0;
function usageFile(usage: Usage): string {
  const file = join(dir, `usage-${(serial += 1)}.jsonl`);
  const lines = [
    ...usage.databases.map((value) => ({ kind: "database", value })),
    ...usage.redis.map((value) => ({ kind: "redis", value })),
    ...(usage.parallel ? [{ kind: "parallel", value: usage.parallel }] : []),
  ];
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return file;
}

const session = (id: string): Usage => ({
  databases: [`lyx_test_tpl_${id}`, `lyx_test_db_${id}_1`, `lyx_test_services_${id}_2`],
  redis: [`lyx:test:${id}:1:`, `lyx:test:${id}:2:`],
  parallel: [1, 2, 3, 4].map((worker) => `lyx_test_db_${id}_${worker}_par`),
});

function check(a: string, b: string) {
  const result = spawnSync(process.execPath, [SCRIPT, "--check", a, b], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("test:isolation 核对两份用量记录", () => {
  it("两个会话各用各的：通过", () => {
    const result = check(usageFile(session("ia")), usageFile(session("ib")));
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("甲：库 7 个，Redis 前缀 2 个");
    expect(result.output).toContain("库名交集 0 个，Redis 前缀交集 0 个");
  });

  it("库名有交集：不通过，点出是哪个库", () => {
    const b = session("ib");
    b.databases.push("lyx_test_db_ia_1");
    const result = check(usageFile(session("ia")), usageFile(b));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("不通过：库名有交集：lyx_test_db_ia_1");
  });

  it("Redis 前缀有交集：不通过，点出是哪个前缀", () => {
    const b = session("ib");
    b.redis.push("lyx:test:ia:2:");
    const result = check(usageFile(session("ia")), usageFile(b));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("不通过：Redis 前缀有交集：lyx:test:ia:2:");
  });

  it("并行的那条记录里的库也算数：与另一边重了同样不通过", () => {
    const b = session("ib");
    b.parallel = session("ia").parallel;
    const result = check(usageFile(session("ia")), usageFile(b));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("库名有交集：lyx_test_db_ia_1_par");
  });

  it("缺东西：没有库、没有 Redis 前缀、没有 4 个 worker 的记录、只有 3 个库的记录，都不通过", () => {
    const a = usageFile(session("ia"));
    const cases: Array<[Usage, string]> = [
      [{ ...session("ib"), databases: [], parallel: undefined }, "乙的用量记录里没有库"],
      [{ ...session("ib"), redis: [] }, "乙的用量记录里没有 Redis 前缀"],
      [
        { ...session("ib"), parallel: undefined },
        "乙没有“4 个 worker 同时在场、4 个互不相同的库”的记录",
      ],
      [
        {
          ...session("ib"),
          parallel: ["lyx_test_db_ib_1_par", "lyx_test_db_ib_2_par", "lyx_test_db_ib_3_par"],
        },
        "乙没有“4 个 worker 同时在场、4 个互不相同的库”的记录",
      ],
    ];
    for (const [usage, reason] of cases) {
      const result = check(a, usageFile(usage));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`不通过：${reason}`);
    }
  });

  it("用了不带测试前缀的库或键前缀：不通过", () => {
    const b = session("ib");
    b.databases.push("liyoxi");
    b.redis.push("lyx:local:");
    const result = check(usageFile(session("ia")), usageFile(b));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("乙用了不带测试前缀的库：liyoxi");
    expect(result.output).toContain("乙用了不带测试前缀的 Redis 键前缀：lyx:local:");
  });

  it("记录读不了、不是 JSON：退出码 1；用法写错：退出码 2", () => {
    const a = usageFile(session("ia"));
    const missing = check(a, join(dir, "没有这个文件.jsonl"));
    expect(missing.status, missing.output).toBe(1);
    expect(missing.output).toContain("用量记录读不了");
    const broken = join(dir, "broken.jsonl");
    writeFileSync(broken, "这一行不是 JSON\n");
    const bad = check(a, broken);
    expect(bad.status, bad.output).toBe(1);
    expect(bad.output).toContain("第 1 行不是 JSON");
    for (const args of [
      ["--check", a],
      ["--bogus"],
      ["--scope"],
      ["--scope", "some"],
      ["--workers"],
      ["--workers", "0"],
      ["--workers", "four"],
    ]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
      expect(result.status, args.join(" ")).toBe(2);
    }
  });
});

describe("test:isolation 的范围与并行数", () => {
  const dryRun = (...args: string[]) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args, "--dry-run"], {
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  };
  const commandOf = (output: string) => /每个会话的命令：pnpm test (.+)/.exec(output)?.[1] ?? "";

  it("缺省跑全量；每个会话的 worker 数按核数定：合起来不超过可用核数，最多 4 个、至少 1 个", () => {
    const result = dryRun();
    expect(result.status, result.output).toBe(0);
    const match = /同时跑全量测试，各 (\d+) 个 worker（本机可用 (\d+) 核）/.exec(result.output);
    const [workers, cores] = [Number(match?.[1]), Number(match?.[2])];
    expect(cores).toBe(availableParallelism());
    expect(workers).toBeGreaterThanOrEqual(1);
    expect(workers).toBeLessThanOrEqual(4);
    // 不挤：两个会话合起来不超过核数（核数不到 2 时各 1 个是下限）
    expect(workers === 1 || workers * 2 <= cores).toBe(true);
    // 也不浪费：再多一个就超了，或者已经到 4 个的上限
    expect(workers === 4 || (workers + 1) * 2 > cores).toBe(true);
    // 不带 --project：全部项目都跑
    expect(commandOf(result.output)).toBe(`--maxWorkers=${workers}`);
  });

  it("--workers 显式指定；比核数多时提醒一句", () => {
    const result = dryRun("--workers", "3");
    expect(result.status, result.output).toBe(0);
    expect(commandOf(result.output)).toBe("--maxWorkers=3");
    const crowded = dryRun("--workers", "99");
    expect(crowded.output).toContain("两个会话合起来 198 个 worker");
  });

  it("--scope connected：只跑挂了 globalSetup 的项目，不连库的项目不在里面", () => {
    const result = dryRun("--scope", "connected", "--workers", "2");
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("同时跑连库的测试项目（挂了 globalSetup 的：");
    const command = commandOf(result.output);
    expect(command.startsWith("--maxWorkers=2 --project ")).toBe(true);
    const projects = [...command.matchAll(/--project (\S+)/g)].map((match) => match[1]);
    // 连库、连 Redis 的用例现在在这两个项目里；以后挂上 globalSetup 的包自动进来
    expect(projects).toContain("db");
    expect(projects).toContain("services");
    for (const pure of ["infra", "shared", "contract"]) expect(projects).not.toContain(pure);
  });
});
