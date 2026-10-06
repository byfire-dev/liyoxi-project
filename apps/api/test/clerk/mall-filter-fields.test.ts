import { describe, expect, it } from "vitest";

import { clerkVisibleKeys } from "./visible-keys.js";

const operationId = "m.mallConfig.get";
const band = { key: "low", label: "千分以内", min: null, max: 1000 };
const scanBands = (priceBands: unknown): string[] =>
  clerkVisibleKeys(operationId, { filters: { priceBands } });
const rejects = (data: unknown, route = operationId): void => {
  expect(() => clerkVisibleKeys(route, data)).toThrow("店员禁用字段");
};

describe("商城公开筛选元数据的精确店员扫描例外", () => {
  it("仅放行既定布尔开关与严格分档，并记录分档内部完整路径", () => {
    expect(clerkVisibleKeys(operationId, { filters: { price: false, priceBands: [] } })).toEqual([
      "filters",
      "filters.price",
      "filters.priceBands",
    ]);
    expect(
      clerkVisibleKeys(operationId, {
        filters: {
          price: true,
          priceBands: [band, { key: "high", label: "千分以上", min: 1001, max: null }],
        },
      }),
    ).toEqual([
      "filters",
      "filters.price",
      "filters.priceBands",
      "filters.priceBands[].key",
      "filters.priceBands[].label",
      "filters.priceBands[].max",
      "filters.priceBands[].min",
    ]);
  });

  it("复用契约边界：最多六档、零端点、闭区间、安全整数、24位key和10码点label", () => {
    const bands = Array.from({ length: 6 }, (_, index) => ({
      key: index === 0 ? `a${"_".repeat(23)}` : `band_${String(index)}`,
      label: index === 0 ? "😀".repeat(10) : `档位${String(index)}`,
      min: index === 0 ? 0 : index,
      max: index === 0 ? 0 : Number.MAX_SAFE_INTEGER,
    }));
    expect(() => scanBands(bands)).not.toThrow();
  });

  it.each(["m.home.get", "m.drama.list", "m.sample"])("其它路由 %s 仍拒绝两种同名字段", (route) => {
    rejects({ filters: { price: false } }, route);
    rejects({ filters: { priceBands: [band] } }, route);
  });

  it.each([
    { nested: { filters: { price: false } } },
    { nested: { filters: { priceBands: [band] } } },
    { filters: [{ price: false }] },
    { filters: [{ priceBands: [band] }] },
    { price: false },
    { priceBands: [band] },
    { filters: { nested: { price: false } } },
    { filters: { nested: { priceBands: [band] } } },
    { filters: { otherPrice: false } },
    { filters: { priceFen: 1000 } },
  ])("嵌套、数组中的同名字段与其它price字段仍拒绝：%j", (data) => {
    rejects(data);
  });

  it.each([null, 0, 1, "false", "1000", [], {}, { balance: 1 }])(
    "price不是布尔值仍拒绝：%j",
    (price) => {
      rejects({ filters: { price } });
    },
  );

  it.each([null, false, 1000, "1000", band, [null], [false], ["1000"], [[]]])(
    "priceBands不是严格分档数组仍拒绝：%j",
    (priceBands) => {
      expect(() => scanBands(priceBands)).toThrow("店员禁用字段");
    },
  );

  it.each([
    { label: band.label, min: band.min, max: band.max },
    { key: band.key, min: band.min, max: band.max },
    { key: band.key, label: band.label, max: band.max },
    { key: band.key, label: band.label, min: band.min },
    { ...band, key: "UPPER" },
    { ...band, key: "1low" },
    { ...band, key: "bad-key" },
    { ...band, key: "" },
    { ...band, key: `a${"_".repeat(24)}` },
    { ...band, key: 1 },
    { ...band, label: "" },
    { ...band, label: "  " },
    { ...band, label: "😀".repeat(11) },
    { ...band, label: 1 },
    { ...band, min: -1 },
    { ...band, max: -1 },
    { ...band, min: 0.5 },
    { ...band, max: 0.5 },
    { ...band, min: "0" },
    { ...band, max: "1000" },
    { ...band, min: false },
    { ...band, max: true },
    { ...band, min: Number.NaN },
    { ...band, max: Number.POSITIVE_INFINITY },
    { ...band, max: Number.MAX_SAFE_INTEGER + 1 },
    { ...band, min: null, max: null },
    { ...band, min: 1001, max: 1000 },
    { ...band, extra: "公开文字" },
    { ...band, balance: 1 },
    { ...band, detail: { phone: "13800138001" } },
    { ...band, label: { phone: "13800138001" } },
  ])("畸形分档、错误类型或多余键仍拒绝：%j", (invalidBand) => {
    expect(() => scanBands([invalidBand])).toThrow("店员禁用字段");
  });

  it.each([
    [band, { ...band, label: "另一档" }],
    [band, { ...band, key: "other" }],
    Array.from({ length: 7 }, (_, index) => ({
      ...band,
      key: `band_${String(index)}`,
      label: `档位${String(index)}`,
    })),
  ])("重复key/label或超过六档仍拒绝：%j", (...bands) => {
    expect(() => scanBands(bands)).toThrow("店员禁用字段");
  });

  it("放行后继续扫描同级、嵌套与数组，不开放敏感字段或目录价全局例外", () => {
    for (const forbidden of [
      "points",
      "balance",
      "amount",
      "priceFen",
      "contract",
      "invoice",
      "uscc",
      "license",
      "phone",
    ]) {
      rejects({ filters: { price: false, priceBands: [band], [forbidden]: 1 } });
      rejects({ filters: { price: false, priceBands: [band] }, nested: [{ [forbidden]: 1 }] });
    }
    rejects({ listPricePoints: 1000 });
    rejects({ adUnitPoints: 100 });
  });

  it("保留Mask、动态字典值扫描与needPhone原有精确边界", () => {
    expect(
      clerkVisibleKeys("m.sample", {
        phoneMask: "138****8001",
        flags: { "invoice.feature": false },
      }),
    ).toEqual(["flags", "flags.*", "phoneMask"]);
    rejects({ flags: { any: { phone: "13800138001" } } }, "m.sample");
    expect(clerkVisibleKeys("m.session.create", { needPhone: true })).toEqual(["needPhone"]);
    rejects({ needPhone: "13800138001" }, "m.session.create");
    rejects({ needPhone: true }, "m.sample");
    rejects({ nested: { needPhone: true } }, "m.session.create");
    rejects({ hasPhone: true }, "m.session.create");
  });
});
