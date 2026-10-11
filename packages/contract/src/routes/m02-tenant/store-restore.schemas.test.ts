import { describe, expect, it } from "vitest";
import { StoreCardSchema, StoreRestoreParamsSchema } from "./tenant.schemas.js";
import { M02_ERROR_DETAILS } from "./error-details.js";
import { mStoreRestore } from "./stores.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const card = {
  storeId: id,
  name: "恢复门店",
  isPrimary: false,
  lifecycle: "active",
  isLastSelected: false,
  city: null,
  category: null,
  qualificationStatus: "unsubmitted",
  assetCount: 0,
  clerkCount: 0,
  todoCount: 0,
  archiveReason: null,
  archivedAt: null,
  verifiedAt: null,
  submittedAt: null,
  expectedDecisionAt: null,
  completenessPct: 0,
  liveCount: 0,
  deliveringCount: 0,
  pendingInvitationCount: 0,
  memberPreview: [],
  actions: ["archive", "delete"],
};

describe("门店恢复正式契约", () => {
  it("参数只接受完整小写 v7，未知参数与路径变体拒绝", () => {
    expect(StoreRestoreParamsSchema.parse({ storeId: id })).toEqual({ storeId: id });
    for (const storeId of [id.toUpperCase(), id.replace("abcd", "aBcd"), "bad", "", `${id} `])
      expect(StoreRestoreParamsSchema.safeParse({ storeId }).success).toBe(false);
    expect(StoreRestoreParamsSchema.safeParse({}).success).toBe(false);
    expect(StoreRestoreParamsSchema.safeParse({ storeId: id, force: true }).success).toBe(false);
  });

  it("复用完整老板卡；每个字段必需，沿原卡规则裁剪额外字段", () => {
    expect(StoreCardSchema.parse(card)).toEqual(card);
    for (const key of Object.keys(card)) {
      const missing: Record<string, unknown> = { ...card };
      delete missing[key];
      expect(StoreCardSchema.safeParse(missing).success).toBe(false);
    }
    expect(StoreCardSchema.parse({ ...card, phone: "13800138000", token: "private" })).toEqual(
      card,
    );
    for (const patch of [
      { completenessPct: 101 },
      { clerkCount: -1 },
      { assetCount: 0.5 },
      { memberPreview: Array.from({ length: 5 }, () => ({ displayName: null, role: "owner" })) },
      { actions: ["force_restore"] },
    ])
      expect(StoreCardSchema.safeParse({ ...card, ...patch }).success).toBe(false);
  });

  it.each(["plan", "inactive"] as const)("额度错误 %s 只接受正式三键与非负整数", (limitReason) => {
    const schema = M02_ERROR_DETAILS.STORE_LIMIT_REACHED;
    const details = { storesUsed: 2, storeLimit: 1, limitReason };
    expect(schema.parse(details)).toEqual(details);
    expect(schema.parse({ storesUsed: 0, storeLimit: 0, limitReason })).toEqual({
      storesUsed: 0,
      storeLimit: 0,
      limitReason,
    });
    for (const key of Object.keys(details)) {
      const missing: Record<string, unknown> = { ...details };
      delete missing[key];
      expect(schema.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { storesUsed: -1 },
      { storeLimit: -1 },
      { storesUsed: 0.5 },
      { storeLimit: 1.5 },
      { limitReason: "unknown" },
      { storeName: "private" },
      { force: true },
    ])
      expect(schema.safeParse({ ...details, ...patch }).success).toBe(false);
  });

  it("真实 POST 无JSON body声明，required 幂等、老板能力和全部错误响应", () => {
    expect(mStoreRestore.operationId).toBe("m.store.restore");
    expect(mStoreRestore.path).toBe("/api/v1/m/stores/{storeId}/restore");
    expect(mStoreRestore.method).toBe("post");
    expect(mStoreRestore["x-auth"]).toBe("member");
    expect(mStoreRestore["x-capability"]).toBe("store.restore");
    expect(mStoreRestore["x-clerk-view"]).toBe("none");
    expect(mStoreRestore["x-idempotent"]).toBe("required");
    expect(mStoreRestore.request?.params).toBe(StoreRestoreParamsSchema);
    expect(Object.keys(mStoreRestore.request ?? {})).toEqual(["params"]);
    expect(Object.keys(mStoreRestore.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
    ]);
  });
});
