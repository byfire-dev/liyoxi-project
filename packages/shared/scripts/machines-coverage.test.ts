// 覆盖检查骨架的自测（任务书 W0-12 第 7 节第 6 条）：行引用怎么读、一行算不算被引用；真实数据上跑得出数。
// 不钉具体的覆盖数字：它随接口文档补行号而变，M1 起才是门禁。
import { describe, expect, it } from "vitest";

import { CHAINS, chain } from "../src/machines/index.js";

import { REFERENCE_SOURCES, coverageOf, parseRefs } from "./machines-coverage.js";

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
