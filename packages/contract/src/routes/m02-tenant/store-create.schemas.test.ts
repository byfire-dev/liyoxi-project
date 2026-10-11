import { describe, expect, it } from "vitest";
import { StoreCreateBodySchema, STORE_COPY_OPTIONS } from "./tenant.schemas.js";
import { mStoreCreate } from "./stores.js";
import { THREE_PHASE_OPERATIONS } from "../three-phase.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const body = {
  name: "公开新门店",
  addressDetail: "公开测试路一号",
  industryCode: "C900",
  categoryCode: "C901",
};

describe("新增分店正式请求契约", () => {
  it("仅修剪店名；省略与显式空复制选择均合法", () => {
    expect(StoreCreateBodySchema.parse({ ...body, name: "  公开新门店  " })).toEqual(body);
    expect(
      StoreCreateBodySchema.parse({ ...body, copyFromStoreId: null, copyOptions: [] }),
    ).toEqual({
      ...body,
      copyFromStoreId: null,
      copyOptions: [],
    });
    expect(StoreCreateBodySchema.parse({ ...body, copyFromStoreId: id })).toEqual({
      ...body,
      copyFromStoreId: id,
    });
  });

  it.each([
    [],
    ["basic"],
    ["service"],
    ["media"],
    ["brand_assets"],
    ["basic", "service"],
    ["basic", "media"],
    ["basic", "brand_assets"],
    ["service", "media"],
    ["service", "brand_assets"],
    ["media", "brand_assets"],
    ["basic", "service", "media"],
    ["basic", "service", "brand_assets"],
    ["basic", "media", "brand_assets"],
    ["service", "media", "brand_assets"],
    ["basic", "service", "media", "brand_assets"],
  ])("复制组合 %j 只接受正式四项且保留顺序", (...copyOptions) => {
    expect(StoreCreateBodySchema.parse({ ...body, copyFromStoreId: id, copyOptions })).toEqual({
      ...body,
      copyFromStoreId: id,
      copyOptions,
    });
  });

  it.each([2, 30])("店名上界按Unicode码点计数：%i", (length) => {
    const name = "🍜".repeat(length);
    expect(StoreCreateBodySchema.parse({ ...body, name }).name).toBe(name);
  });

  it.each([
    { name: " " },
    { name: "一" },
    { name: "🍜".repeat(31) },
    { addressDetail: "" },
    { addressDetail: " \n\t" },
    { addressDetail: "地".repeat(201) },
    { industryCode: "" },
    { categoryCode: "" },
    { industryCode: "C".repeat(65) },
    { categoryCode: "C".repeat(65) },
    { copyFromStoreId: id.toUpperCase() },
    { copyFromStoreId: `${id}\n` },
    { copyOptions: ["basic"] },
    { copyFromStoreId: null, copyOptions: ["brand_assets"] },
    { copyFromStoreId: id, copyOptions: ["basic", "basic"] },
    { copyFromStoreId: id, copyOptions: ["qualification"] },
    { copyFromStoreId: id, copyOptions: [...STORE_COPY_OPTIONS, "basic"] },
    { name: null },
    { provinceCode: "110000" },
    { targetStoreId: id },
    { isPrimary: true },
    { lifecycle: "active" },
    { qualificationStatus: "verified" },
    { locksHeld: true },
  ])("拒绝不合法边界或私有字段 %j", (patch) => {
    expect(StoreCreateBodySchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });

  it("四个正式必填字段不可缺失，合法长度边界保留", () => {
    for (const key of Object.keys(body)) {
      const missing: Record<string, unknown> = { ...body };
      delete missing[key];
      expect(StoreCreateBodySchema.safeParse(missing).success).toBe(false);
    }
    expect(
      StoreCreateBodySchema.safeParse({
        ...body,
        addressDetail: "地".repeat(200),
        industryCode: "C".repeat(64),
        categoryCode: "C".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("老板POST要求原required三段式并返回完整StoreCard", () => {
    expect(mStoreCreate.operationId).toBe("m.store.create");
    expect(mStoreCreate.path).toBe("/api/v1/m/stores");
    expect(mStoreCreate.method).toBe("post");
    expect(mStoreCreate["x-auth"]).toBe("member");
    expect(mStoreCreate["x-capability"]).toBe("store.create");
    expect(mStoreCreate["x-clerk-view"]).toBe("none");
    expect(mStoreCreate["x-idempotent"]).toBe("required");
    expect(mStoreCreate["x-three-phase"]).toBe(true);
    expect(THREE_PHASE_OPERATIONS["m.store.create"]).toBe("external-first");
    expect(mStoreCreate.request?.body?.content["application/json"].schema).toBe(
      StoreCreateBodySchema,
    );
    expect(Object.keys(mStoreCreate.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "409",
      "503",
    ]);
  });
});
