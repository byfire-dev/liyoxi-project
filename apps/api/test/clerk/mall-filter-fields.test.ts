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

describe("门店公开卖点标签的精确店员扫描例外", () => {
  const route = "m.storeProfile.service.get";
  const tag = { code: "service", name: "服务周到" };
  const scan = (sellingPoints: unknown) => clerkVisibleKeys(route, { sellingPoints });

  it("仅放行顶层 DictRef 数组并继续记录完整子路径", () => {
    expect(scan([])).toEqual(["sellingPoints"]);
    expect(scan([tag])).toEqual(["sellingPoints", "sellingPoints[].code", "sellingPoints[].name"]);
  });

  it.each(["m.storeProfile.get", "m.home.get", "m.drama.get", "m.sample"])(
    "其它操作 %s 仍拒绝同名字段",
    (other) => rejects({ sellingPoints: [tag] }, other),
  );

  it.each([
    { nested: { sellingPoints: [tag] } },
    { items: [{ sellingPoints: [tag] }] },
    { serviceItems: [{ sellingPoints: [tag] }] },
  ])("嵌套或数组中的同名字段仍拒绝：%j", (data) => rejects(data, route));

  it.each([
    null,
    false,
    100,
    "100",
    tag,
    [null],
    [false],
    [100],
    ["100"],
    [[]],
    [{ code: tag.code }],
    [{ name: tag.name }],
    [{ ...tag, code: 1 }],
    [{ ...tag, name: { phone: "13800138001" } }],
    [{ ...tag, extra: "公开文字" }],
    [{ ...tag, points: 1 }],
    [{ ...tag, nested: { balance: 1 } }],
  ])("错误类型、缺项与多余键均拒绝：%j", (value) => {
    expect(() => scan(value)).toThrow("店员禁用字段");
  });

  it("同级与嵌套敏感字段仍拒绝，目录价仅按原完整路径登记", () => {
    for (const key of [
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
      rejects({ sellingPoints: [tag], [key]: 1 }, route);
      rejects({ sellingPoints: [tag], nested: [{ [key]: 1 }] }, route);
    }
    rejects({ sellingPoints: [tag], serviceItems: [{ price: 1000 }] }, route);
    rejects({ sellingPoints: [tag], nested: { originalPriceFen: 2000 } }, route);
  });
});

describe("邀请公开预览布尔决策的精确店员扫描例外", () => {
  const operationId = "m.invitation.lookup";
  const rejects = (data: unknown, route = operationId): void => {
    expect(() => clerkVisibleKeys(route, data)).toThrow("店员禁用字段");
  };

  it.each([true, false])("仅放行顶层布尔值 %s 并记录完整路径", (isPhoneRestricted) => {
    expect(clerkVisibleKeys(operationId, { isPhoneRestricted })).toEqual(["isPhoneRestricted"]);
  });

  it.each([
    { value: "true" },
    { value: "false" },
    { value: "13800138001" },
    { value: 0 },
    { value: 1 },
    { value: null },
    { value: undefined },
    { value: {} },
    { value: { value: true } },
    { value: { phone: "13800138001" } },
    { value: [] },
    { value: [true] },
  ])("同名字段的非布尔类型仍拒绝：%j", ({ value: isPhoneRestricted }) => {
    rejects({ isPhoneRestricted });
  });

  it.each([
    { data: { nested: { isPhoneRestricted: true } } },
    { data: { nested: { isPhoneRestricted: false } } },
    { data: { items: [{ isPhoneRestricted: true }] } },
    { data: [{ isPhoneRestricted: false }] },
    { data: { isPhoneRestricted: true, preview: { isPhoneRestricted: false } } },
  ])("嵌套、数组与顶层之外的同名字段仍拒绝：%j", ({ data }) => {
    rejects(data);
  });

  it.each([
    "m.invitation.create",
    "m.invitation.markShared",
    "m.invitation.accept",
    "m.invitation.revoke",
    "m.session.create",
    "m.sample",
    "m.invitation.lookup.extra",
    "M.INVITATION.LOOKUP",
  ])("其他 operationId %s 不放行该字段", (route) => {
    rejects({ isPhoneRestricted: true }, route);
    rejects({ isPhoneRestricted: false }, route);
  });

  it.each(["phone", "targetPhone", "phoneNumber", "isPhoneRestrictedText", "hasPhone"])(
    "已放行布尔值不开放同层敏感键 %s",
    (key) => {
      rejects({ isPhoneRestricted: true, [key]: "13800138001" });
      rejects({ isPhoneRestricted: false, [key]: null });
      rejects({ isPhoneRestricted: true, nested: [{ [key]: "13800138001" }] });
    },
  );

  it("布尔例外不开放其它原禁用类别，也不改变 Mask 与登录决策边界", () => {
    for (const key of [
      "points",
      "balance",
      "amount",
      "price",
      "contract",
      "invoice",
      "uscc",
      "license",
    ])
      rejects({ isPhoneRestricted: true, [key]: 1 });
    expect(
      clerkVisibleKeys(operationId, {
        isPhoneRestricted: false,
        phoneMask: "138****8001",
        storeName: "公开虚构门店",
      }),
    ).toEqual(["isPhoneRestricted", "phoneMask", "storeName"]);
    expect(clerkVisibleKeys("m.session.create", { needPhone: false })).toEqual(["needPhone"]);
    rejects({ needPhone: false });
  });
});
