import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, inject, it, vi } from "vitest";

import { runNestedVitest } from "./__fixtures__/nested.js";
import { listTestDatabases, recordTestUsage, resolveTestSession } from "./database.js";

// 连库、连 Redis、起子进程的用例：实例忙的时候（别的会话同时在跑）会慢，时限放宽，不用缺省的 5 秒
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// 4 个 Vitest worker 并行（W0-05b 任务书 第 7 节第 1 条）：运行期间有 4 个互不相同的 lyx_test_ 库。
// 做法：嵌套跑一轮 4 个 worker、4 个文件；每个文件连自己的库，等到四个 worker 同时在场才往下走，
// 再核对四条连接落在四个不同的库上、自己的库里只有自己写的数据（__fixtures__/parallel-case.ts）。
// 嵌套着跑是为了不受外层这一轮并行数的影响：外层是 1 个 worker 还是 8 个，这里都是确定的 4 个。

interface ParallelRecord {
  kind: string;
  value: { tag: string; worker: string; databases: string[] };
}

it("这一轮的并行数由 globalSetup 给出", () => {
  expect(inject("lyxTestMaxWorkers")).toBeGreaterThanOrEqual(1);
  expect(Number(process.env.VITEST_POOL_ID)).toBeLessThanOrEqual(inject("lyxTestMaxWorkers"));
});

it("4 个 worker 同时在跑，各有一个 lyx_test_ 库，互不相同", { timeout: 180_000 }, async () => {
  const session = resolveTestSession();
  const dir = mkdtempSync(join(tmpdir(), "lyx-parallel-"));
  try {
    const usage = join(dir, "usage.jsonl");
    const result = runNestedVitest("parallel-", {
      maxWorkers: 4,
      env: { LYX_TEST_USAGE_FILE: usage },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/Test Files\s+4 passed \(4\)/);

    const records = readFileSync(usage, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ParallelRecord)
      .filter((record) => record.kind === "parallel")
      .map((record) => record.value);
    expect(records.map((record) => record.tag).sort()).toEqual(["a", "b", "c", "d"]);
    // 四个文件落在四个不同的 worker 上
    expect(records.map((record) => record.worker).sort()).toEqual(["1", "2", "3", "4"]);
    // 四个 worker 看到的是同一组、四个互不相同的库，名字带本会话与各自的 worker 编号
    const databases = records[0]?.databases ?? [];
    expect(databases).toEqual(
      ["1", "2", "3", "4"].map((worker) => `lyx_test_db_${session}_${worker}_par`),
    );
    for (const record of records) expect(record.databases).toEqual(databases);
    // 用例全过，四个库都已经删掉
    const left = await listTestDatabases({ session });
    expect(left.filter((name) => name.endsWith("_par"))).toEqual([]);
    // 记进外层这一轮的用量记录（pnpm test:isolation 核对它）
    recordTestUsage("parallel", databases);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
