import { describe, expect, it } from "vitest";
import { balanceIsolationShards, parseIsolationTimings } from "../isolation-balance.mjs";
import type { IsolationFile } from "../isolation-balance.mjs";

const file = (id: number): IsolationFile => ({
  project: "services",
  file: `packages/services/src/fixture-${id}.test.ts`,
});
const hints = (files: { file: string; milliseconds: number }[] = []) => ({
  schemaVersion: 1,
  defaultMilliseconds: 1000,
  files,
});
const keys = (files: readonly IsolationFile[]) =>
  files.map((row) => `${row.project}:${row.file}`).sort();

describe("隔离分片的耗时提示只影响归属", () => {
  it("合成偏斜反例：原数量完全均衡仍可堆满重文件，重排降低最大成本且保留全集", () => {
    const baseline = Array.from({ length: 4 }, (_, shard) =>
      Array.from({ length: 8 }, (_, index) => file(shard * 8 + index)),
    );
    const heavy = baseline[3]!.slice(0, 4).map((row, index) => ({
      file: row.file,
      milliseconds: 100_000 - index * 10_000,
    }));
    const timings = parseIsolationTimings(hints(heavy));
    const cost = (groups: IsolationFile[][]) =>
      groups.map((rows) =>
        rows.reduce(
          (total, row) => total + (timings.weights.get(row.file) ?? timings.defaultMilliseconds),
          0,
        ),
      );
    const result = balanceIsolationShards(baseline, timings);
    expect(baseline.map((rows) => rows.length)).toEqual([8, 8, 8, 8]);
    expect(result.map((rows) => rows.length)).toEqual([8, 8, 8, 8]);
    expect(keys(result.flat())).toEqual(keys(baseline.flat()));
    expect(new Set(keys(result.flat())).size).toBe(32);
    expect(Math.max(...cost(result))).toBeLessThan(Math.max(...cost(baseline)) / 2);
    expect(
      result.map((rows) => rows.filter((row) => timings.weights.has(row.file)).length),
    ).toEqual([1, 1, 1, 1]);
  });

  it("相同输入确定分配，提示登记顺序不影响结果，不修改 Vitest 原名单", () => {
    const baseline = Array.from({ length: 4 }, (_, shard) =>
      Array.from({ length: 5 }, (_, index) => file(shard * 5 + index)),
    );
    const before = structuredClone(baseline);
    const heavy = [file(0), file(1), file(2)].map((row, index) => ({
      file: row.file,
      milliseconds: 30_000 + index * 10_000,
    }));
    const first = balanceIsolationShards(baseline, parseIsolationTimings(hints(heavy)));
    expect(balanceIsolationShards(baseline, parseIsolationTimings(hints(heavy)))).toEqual(first);
    expect(
      balanceIsolationShards(baseline, parseIsolationTimings(hints([...heavy].reverse()))),
    ).toEqual(first);
    expect(baseline).toEqual(before);
  });

  it("未知新文件及原跳过文件仍在全集，过期提示不决定范围或执行", () => {
    const baseline = [[file(0), { ...file(1), skipped: true }], [file(2)], [file(3)], [file(4)]];
    const result = balanceIsolationShards(
      baseline,
      parseIsolationTimings(hints([{ file: file(999).file, milliseconds: 999_000 }])),
    );
    expect(result).toEqual(baseline);
    expect(keys(result.flat())).toEqual(keys(baseline.flat()));
    expect(result.flat().find((row) => row.file === file(1).file)).toHaveProperty("skipped", true);
    expect(result.flat().some((row) => row.file === file(999).file)).toBe(false);
  });

  it("全是重文件、不能整除或少于片数，仍每项恰好一次且数量差不超过一", () => {
    for (const count of [0, 1, 3, 4, 5, 13, 31]) {
      let offset = 0;
      const baseline = Array.from({ length: 4 }, (_, shard) => {
        const size = Math.floor(count / 4) + Number(shard < count % 4);
        return Array.from({ length: size }, () => file(offset++));
      });
      const timings = parseIsolationTimings(
        hints(
          baseline.flat().map((row, index) => ({ file: row.file, milliseconds: 90_000 - index })),
        ),
      );
      const result = balanceIsolationShards(baseline, timings);
      expect(keys(result.flat())).toEqual(keys(baseline.flat()));
      expect(new Set(keys(result.flat())).size).toBe(count);
      const sizes = result.map((rows) => rows.length);
      expect(sizes).toEqual(baseline.map((rows) => rows.length));
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it("无效/重复提示和重复原名单明确失败，不默默漏掉文件", () => {
    for (const value of [
      null,
      { ...hints(), schemaVersion: 2 },
      { ...hints(), defaultMilliseconds: 0 },
      hints([{ file: file(1).file, milliseconds: -1 }]),
      hints([{ file: "../escape.test.ts", milliseconds: 1 }]),
      hints([{ file: "packages/../escape.test.ts", milliseconds: 1 }]),
      hints([
        { file: file(1).file, milliseconds: 1000 },
        { file: file(1).file, milliseconds: 2000 },
      ]),
    ]) {
      expect(() => parseIsolationTimings(value)).toThrow();
    }
    expect(() =>
      balanceIsolationShards([[file(0)], [file(0)]], parseIsolationTimings(hints())),
    ).toThrow();
    expect(() =>
      balanceIsolationShards([[file(0), file(1)], []], parseIsolationTimings(hints())),
    ).toThrow();
  });
});
