import { describe, expect, it } from "vitest";
import {
  StoreDeleteParamsSchema,
  StoreDeleteResultSchema,
  StoreNotDraftReasonSchema,
} from "./tenant.schemas.js";
import { M02_ERROR_DETAILS } from "./error-details.js";
import { mStoreDelete } from "./stores.js";

const storeId = "018fabcd-0000-7000-8000-000000000001";
const deletedAt = "2026-10-12T00:00:00.000Z";

describe("草稿门店删除正式契约", () => {
  it("路径只接受严格小写 v7，拒绝未知键与缺失参数", () => {
    expect(StoreDeleteParamsSchema.parse({ storeId })).toEqual({ storeId });
    for (const value of [
      storeId.toUpperCase(),
      storeId.replace("abcd", "aBcd"),
      "bad",
      "",
      `${storeId} `,
    ])
      expect(StoreDeleteParamsSchema.safeParse({ storeId: value }).success).toBe(false);
    expect(StoreDeleteParamsSchema.safeParse({}).success).toBe(false);
    expect(StoreDeleteParamsSchema.safeParse({ storeId, force: true }).success).toBe(false);
  });

  it("成功仅含完整门店 ID 与删除时刻，不接纳门店卡或额外隐私字段", () => {
    const result = { storeId, deletedAt };
    expect(StoreDeleteResultSchema.parse(result)).toEqual(result);
    for (const value of [
      {},
      { storeId },
      { deletedAt },
      { ...result, storeId: storeId.toUpperCase() },
      { ...result, deletedAt: null },
      { ...result, deletedAt: "bad" },
      { ...result, name: "门店" },
      { ...result, token: "private" },
      { ...result, archivedAt: deletedAt },
    ])
      expect(StoreDeleteResultSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { reasons: ["qualification_submitted"] },
    { reasons: ["has_business_data"] },
    { reasons: ["qualification_submitted", "has_business_data"] },
  ])("正式草稿拒绝原因 %j 必须非空且唯一", ({ reasons }) => {
    const schema = M02_ERROR_DETAILS.STORE_NOT_DRAFT;
    expect(schema.parse({ reasons })).toEqual({ reasons });
    for (const reason of reasons) expect(StoreNotDraftReasonSchema.parse(reason)).toBe(reason);
    for (const value of [
      {},
      { reasons: [] },
      { reasons: null },
      { reasons: "has_business_data" },
      { reasons: ["unknown"] },
      { reasons: ["has_business_data", "has_business_data"] },
      { reasons: ["qualification_submitted", "qualification_submitted"] },
      { reasons, count: 1 },
      { reasons, storeName: "private" },
    ])
      expect(schema.safeParse(value).success).toBe(false);
  });

  it("沿原 POST、老板能力与 required 幂等，无 JSON body 声明", () => {
    expect(mStoreDelete.operationId).toBe("m.store.delete");
    expect(mStoreDelete.path).toBe("/api/v1/m/stores/{storeId}/delete");
    expect(mStoreDelete.method).toBe("post");
    expect(mStoreDelete["x-auth"]).toBe("member");
    expect(mStoreDelete["x-capability"]).toBe("store.archive");
    expect(mStoreDelete["x-clerk-view"]).toBe("none");
    expect(mStoreDelete["x-idempotent"]).toBe("required");
    expect(mStoreDelete.request?.params).toBe(StoreDeleteParamsSchema);
    expect(Object.keys(mStoreDelete.request ?? {})).toEqual(["params"]);
    expect(Object.keys(mStoreDelete.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
    ]);
  });
});
