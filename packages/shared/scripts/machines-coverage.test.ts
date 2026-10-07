// 覆盖检查骨架的自测（任务书 W0-12 第 7 节第 6 条）：行引用怎么读、一行算不算被引用；真实数据上跑得出数。
// 不钉具体的覆盖数字：它随接口文档补行号而变，M1 起才是门禁。
import { describe, expect, it } from "vitest";

import { CHAINS, chain } from "../src/machines/index.js";

import {
  REFERENCE_SOURCES,
  coverageOf,
  parseRefs,
  registeredReferences,
  baselineKeys,
  missingBeyondBaseline,
} from "./machines-coverage.js";

describe("行引用怎么读", () => {
  it("两种写法都认，统一成“分组:行号”", () => {
    expect(parseRefs("08-billing-payment.md:164")).toEqual(["08:164"]);
    expect(
      parseRefs("pending → active（qualification.approve，02-identity-tenant.md:623）"),
    ).toEqual(["02:623"]);
    expect(parseRefs("跳过后同事务重判，06:526；触发者待补")).toEqual(["06:526"]);
  });

  it("区间与顿号并列逐行展开", () => {
    expect(parseRefs("01-kernel-flow.md:88-90")).toEqual(["01:88", "01:89", "01:90"]);
    expect(parseRefs("13-notify-docs.md:431、433-434")).toEqual(["13:431", "13:433", "13:434"]);
  });

  it("不是行引用的不认：时刻、比例、版本号、写反的区间", () => {
    expect(parseRefs("次日 09:00:00 触发")).toEqual([]);
    expect(parseRefs("比例 1.10:20，版本 2026:10")).toEqual([]);
    expect(parseRefs("08:20-10")).toEqual([]);
    expect(parseRefs("没有引用")).toEqual([]);
  });
});

describe("一行算不算被引用", () => {
  const sample = chain(
    "staff",
    "status",
    { name: "x", columns: ["staff.status"], values: ["pending", "active", "disabled"] },
    [
      ["03:218", null, "staff.create", ["active"]],
      ["03:219", null, "staff.create", ["pending"]],
      ["03:221", ["active"], "staff.disable", ["disabled"]],
      ["03:221", ["active"], "staff.suspend", ["disabled"]],
    ],
  );

  it("按文档行（ref）算：同一行拆出的几个事件码算一行", () => {
    expect(coverageOf([sample], [{ ref: "03:218", by: "admin.staff.create" }])).toEqual([
      {
        column: "staff.status",
        total: 3,
        uncovered: [
          { ref: "03:219", events: ["staff.create"] },
          { ref: "03:221", events: ["staff.disable", "staff.suspend"] },
        ],
      },
    ]);
  });

  it("引用了别的行不算；全部引用到即没有未覆盖的", () => {
    expect(coverageOf([sample], [{ ref: "02:218", by: "x" }])[0]!.uncovered).toHaveLength(3);
    const all = ["03:218", "03:219", "03:221"].map((ref) => ({ ref, by: "x" }));
    expect(coverageOf([sample], all)[0]!.uncovered).toEqual([]);
  });
});

describe("真实数据", () => {
  it("两个来源都读得出引用；每条链都有结果，未覆盖数不超过总行数", () => {
    const references = REFERENCE_SOURCES.flatMap((source) => {
      const loaded = source.load();
      expect(loaded.length, source.name).toBeGreaterThan(0);
      return loaded;
    });
    const result = coverageOf(CHAINS, references);
    expect(result.map((item) => item.column)).toEqual(CHAINS.map((item) => item.column));
    for (const item of result) {
      expect(item.total, item.column).toBeGreaterThan(0);
      expect(item.uncovered.length, item.column).toBeLessThanOrEqual(item.total);
    }
    // 归属表按“分组:行号”引用了迁移行：至少有一行被覆盖，说明两边用的是同一种行的身份
    expect(result.some((item) => item.uncovered.length < item.total)).toBe(true);
  });
});

// 新契约模式保留旧来源与逐行判据，只以契约身份限定真实引用。
describe("契约身份与存量基线额外门禁", () => {
  const sample = chain(
    "staff",
    "status",
    { name: "baseline", columns: ["staff.status"], values: ["active", "disabled"] },
    [
      ["03:218", null, "staff.create", ["active"]],
      ["03:221", ["active"], "staff.disable", ["disabled"]],
    ],
  );
  const row = { column: "staff.status", ref: "03:218", reason: "存量未引用，尚待真实归属" };
  const snapshot = (rows: { column: string; ref: string; reason: string }[]) =>
    JSON.stringify({ schemaVersion: 1, rows });

  it("契约外接口的真实文字不能贡献引用；登记接口的真实文字可以", () => {
    const result = registeredReferences(
      [{ operationId: "admin.staff.create" }],
      [
        {
          endpoints: [
            { operationId: "fake.staff.disable", transitions: ["03:221"] },
            { operationId: "admin.staff.create", transitions: ["03:218"] },
          ],
        },
      ],
    );
    expect(result).toEqual([{ ref: "03:218", by: "admin.staff.create" }]);
    expect(coverageOf([sample], result)[0]!.uncovered.map((item) => item.ref)).toEqual(["03:221"]);
  });
  it("空或重复契约身份不是可用引用源", () => {
    expect(() => registeredReferences([], [])).toThrow(/为空/);
    expect(() => registeredReferences([{ operationId: "a" }, { operationId: "a" }], [])).toThrow(
      /唯一/,
    );
  });
  it("可追加去除存量的快照，但不能恢复或扩张", () => {
    expect(baselineKeys(`${snapshot([row])}\n${snapshot([])}\n`, [sample]).size).toBe(0);
    expect(() =>
      baselineKeys(`${snapshot([row])}\n${snapshot([])}\n${snapshot([row])}\n`, [sample]),
    ).toThrow(/只减不增/);
  });
  it("未知行、重复行、空原因、改写原因都拒绝", () => {
    expect(() => baselineKeys(snapshot([{ ...row, ref: "03:999" }]), [sample])).toThrow(/未知行/);
    expect(() => baselineKeys(snapshot([row, row]), [sample])).toThrow(/重复行/);
    expect(() => baselineKeys(snapshot([{ ...row, reason: " " }]), [sample])).toThrow(/原因/);
    expect(() =>
      baselineKeys(`${snapshot([row])}\n${snapshot([{ ...row, reason: "变成已覆盖" }])}`, [sample]),
    ).toThrow(/原因不得改写/);
  });
  it("基线不改变覆盖率，新未覆盖行不能自动计为存量", () => {
    const result = coverageOf([sample], []);
    const baseline = baselineKeys(snapshot([row]), [sample]);
    expect(result[0]!.uncovered).toHaveLength(2);
    expect(missingBeyondBaseline(result, baseline).map((item) => item.ref)).toEqual(["03:221"]);
  });
});
