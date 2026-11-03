import { describe, expect, it } from "vitest";

import { balanceIsolationShards, parseIsolationTimings } from "../isolation-balance.mjs";
import { repoRoot, run } from "./helpers.js";

describe("普通四片只均衡归属，首片为既有额外步骤预留负载", () => {
  it("真实 Vitest 全集恰好覆盖一次、原容量不变；新增未知文件自动纳入，其余调用沿原分片与排序", () => {
    // 子进程只解析真实项目并 glob，不导入测试或运行 globalSetup，不需要数据库。
    // 临时文件没有耗时提示，且顶层抛错：若误把枚举变成执行，用例会失败。
    const script = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { readFileSync, rmSync, writeFileSync } from "node:fs";
      import { join, relative } from "node:path";
      import { BaseSequencer, createVitest } from "vitest/node";
      const root = process.cwd();
      const added = join(root, "packages/shared/src/test-shard-probe-" + randomUUID() + ".test.ts");
      const relativeFile = (spec) => relative(root, spec.moduleId).replaceAll("\\\\", "/");
      const key = (spec) => spec.project.name + ":" + relativeFile(spec);
      const keys = (specs) => specs.map(key).sort();
      let ctx;
      writeFileSync(added, 'throw new Error("enumeration must not execute tests");\\n', { flag: "wx" });
      try {
        ctx = await createVitest("test", {
          root, watch: false, project: ["!infra"], shard: "1/4",
        });
        const all = await ctx.globTestSpecifications();
        assert(all.length > 4);
        assert(all.every((spec) => spec.project.name !== "infra"));
        const unknown = all.find((spec) => spec.moduleId === added);
        assert(unknown, "new unrecorded test must be discovered by Vitest");
        const original = [...all];
        const configured = new ctx.config.sequence.sequencer(ctx);
        const base = new BaseSequencer(ctx);
        assert.equal(configured.constructor.name, "BalancedTestSequencer");
        assert.equal(configured.sort, BaseSequencer.prototype.sort);
        const parts = [], baseline = [];
        for (let index = 1; index <= 4; index++) {
          const shard = { index, count: 4 };
          ctx.config.shard = shard;
          baseline.push(await base.shard(all));
          const part = await configured.shard(all);
          assert.equal(ctx.config.shard, shard, "restore original config object");
          assert(part.every((spec) => all.includes(spec)), "keep original specification objects");
          parts.push(part);
          assert.deepEqual(await configured.sort(part), await base.sort(part));
          assert.deepEqual(await configured.shard(all), part, "deterministic ownership");
        }
        assert.deepEqual(all, original, "do not mutate Vitest input");
        assert.deepEqual(parts.map((part) => part.length), baseline.map((part) => part.length));
        assert.deepEqual(keys(parts.flat()), keys(all));
        assert.equal(new Set(keys(parts.flat())).size, all.length);
        assert.equal(parts.filter((part) => part.includes(unknown)).length, 1);

        const hints = JSON.parse(readFileSync(join(root, "infra/ci/test-timings.json"), "utf8"));
        assert.deepEqual(hints.initialLoadsMilliseconds, [500000, 0, 0, 0]);
        assert(!hints.files.some((row) => row.file === relativeFile(unknown)));
        const weights = new Map(hints.files.map((row) => [row.file, row.milliseconds]));
        const load = (part) => part.reduce((sum, spec) => sum + (weights.get(relativeFile(spec)) ?? hints.defaultMilliseconds), 0);
        const costs = parts.map(load);
        const before = baseline.map((part, index) => load(part) + hints.initialLoadsMilliseconds[index]);
        const after = costs.map((cost, index) => cost + hints.initialLoadsMilliseconds[index]);
        assert(costs[0] < Math.min(...costs.slice(1)), "first shard reserves room for its extra serial steps");
        assert(Math.max(...after) < Math.max(...before), "observed heavy-file concentration improves");
        const heavy = [
          "packages/services/src/order/quote.property.test.ts",
          "packages/services/src/ops/ad-cancel-core.db.test.ts",
        ];
        const owners = heavy.map((file) => parts.findIndex((part) => part.some((spec) => relativeFile(spec) === file)));
        assert(owners.every((owner) => owner >= 0));
        assert.notEqual(owners[0], owners[1], "largest two files are separated");

        // 默认、infra、具名项目、隔离枚举及非四片都逐项沿用 BaseSequencer。
        for (const project of [[], ["infra"], ["services"], ["!infra", "api"]]) {
          ctx.config.project = project;
          for (const count of [4, 8]) {
            ctx.config.shard = { index: count, count };
            assert.deepEqual(await configured.shard(all), await base.shard(all));
          }
          assert.deepEqual(await configured.sort(all), await base.sort(all));
        }
        ctx.config.project = ["!infra"];
        for (const count of [1, 3, 8]) {
          ctx.config.shard = { index: count, count };
          assert.deepEqual(await configured.shard(all), await base.shard(all));
        }
        ctx.config.shard = undefined;
        assert.deepEqual(await configured.sort(all), await base.sort(all));
        await assert.rejects(configured.shard(all), TypeError);
        await assert.rejects(base.shard(all), TypeError);
        console.log("TEST_SHARD_PROOF " + JSON.stringify({ files: all.length, capacities: parts.map((part) => part.length), before, after }));
      } finally {
        try { if (ctx) await ctx.close(); }
        finally { rmSync(added, { force: true }); }
      }
    `;
    const result = run(process.execPath, ["--input-type=module", "--eval", script], repoRoot);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("TEST_SHARD_PROOF ");
  });

  it("可选初始负载只改变调度：原零负载结果保持，首片少接重文件且容量和全集不变", () => {
    const baseline = Array.from({ length: 4 }, (_, shard) =>
      Array.from({ length: 8 }, (_, index) => ({
        project: "services",
        file: `packages/services/src/fixture-${shard * 8 + index}.test.ts`,
      })),
    );
    const timings = parseIsolationTimings({
      schemaVersion: 1,
      defaultMilliseconds: 1000,
      files: baseline[0]!.map(({ file }) => ({ file, milliseconds: 10_000 })),
    });
    const before = structuredClone(baseline);
    const zero = balanceIsolationShards(baseline, timings);
    expect(balanceIsolationShards(baseline, timings, [0, 0, 0, 0])).toEqual(zero);
    expect(zero.map((part) => part.filter((row) => timings.weights.has(row.file)).length)).toEqual([
      2, 2, 2, 2,
    ]);
    const initialLoads = Object.freeze([40_000, 0, 0, 0]);
    const reserved = balanceIsolationShards(baseline, timings, initialLoads);
    expect(reserved.map((part) => part.length)).toEqual([8, 8, 8, 8]);
    expect(
      reserved
        .flat()
        .map((row) => row.file)
        .sort(),
    ).toEqual(
      baseline
        .flat()
        .map((row) => row.file)
        .sort(),
    );
    expect(reserved[0]!.filter((row) => timings.weights.has(row.file))).toHaveLength(0);
    expect(baseline).toEqual(before);
    expect(initialLoads).toEqual([40_000, 0, 0, 0]);
  });

  it("初始负载缺项、稀疏、负数、非整数或溢出均失败，不静默改变分片", () => {
    const timings = parseIsolationTimings({
      schemaVersion: 1,
      defaultMilliseconds: 1000,
      files: [],
    });
    const baseline = [[], [], [], []];
    for (const loads of [
      null,
      [],
      [0, 0, 0],
      new Array(4),
      [-1, 0, 0, 0],
      [0.5, 0, 0, 0],
      [Infinity, 0, 0, 0],
      [Number.MAX_SAFE_INTEGER + 1, 0, 0, 0],
    ]) {
      expect(() =>
        balanceIsolationShards(baseline, timings, loads as unknown as readonly number[]),
      ).toThrow("分片初始负载");
    }
  });
});
