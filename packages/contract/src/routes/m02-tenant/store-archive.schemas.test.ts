import { describe, expect, it } from "vitest";
import {
  StoreArchiveParamsSchema,
  StoreArchiveResultSchema,
  StoreBlockerSchema,
} from "./tenant.schemas.js";
import { mStoreArchive } from "./stores.js";
import { M02_ERROR_DETAILS } from "./error-details.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const at = "2026-10-12T00:00:00.000Z";
const store = {
  storeId: id,
  name: "停用门店",
  isPrimary: false,
  lifecycle: "archived",
  isLastSelected: false,
  city: null,
  category: null,
  qualificationStatus: "unsubmitted",
  assetCount: 0,
  clerkCount: 0,
  todoCount: 0,
  archiveReason: "by_owner",
  archivedAt: at,
  verifiedAt: null,
  submittedAt: null,
  expectedDecisionAt: null,
  completenessPct: 0,
  liveCount: 0,
  deliveringCount: 0,
  pendingInvitationCount: 0,
  memberPreview: [],
  actions: ["restore"],
};

describe("门店停用正式 DTO", () => {
  it("完整老板卡与两个真实计数，闭集外层不泄漏副作用明细", () => {
    const result = { store, revokedInvitationCount: 2, removedMemberCount: 3 };
    expect(StoreArchiveResultSchema.parse(result)).toEqual(result);
    for (const key of Object.keys(result)) {
      const missing: Record<string, unknown> = { ...result };
      delete missing[key];
      expect(StoreArchiveResultSchema.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { removedMemberIds: [id] },
      { phone: "13800138000" },
      { removedMemberCount: -1 },
      { revokedInvitationCount: 0.5 },
    ])
      expect(StoreArchiveResultSchema.safeParse({ ...result, ...patch }).success).toBe(false);
  });
  it.each([
    "open_order",
    "open_delivery_ticket",
    "ad_in_production",
    "qualification_in_review",
    "channel_account_in_review",
    "unverified_primary_store",
  ] as const)("真实阻断 %s 只接受正整数与两个字段", (kind) => {
    expect(StoreBlockerSchema.parse({ kind, count: 1 })).toEqual({ kind, count: 1 });
    for (const value of [
      { kind, count: 0 },
      { kind, count: -1 },
      { kind, count: 1.5 },
      { kind, count: 1, ids: [id] },
    ])
      expect(StoreBlockerSchema.safeParse(value).success).toBe(false);
  });
  it("未知 blocker/空阻断/秘密字段拒绝，输入沿现有小写 v7", () => {
    expect(StoreBlockerSchema.safeParse({ kind: "active_ads", count: 1 }).success).toBe(false);
    const schema = M02_ERROR_DETAILS.STORE_HAS_OPEN_WORK;
    expect(schema.parse({ blockers: [{ kind: "open_order", count: 2 }] })).toEqual({
      blockers: [{ kind: "open_order", count: 2 }],
    });
    expect(schema.safeParse({ blockers: [] }).success).toBe(false);
    expect(
      schema.safeParse({ blockers: [{ kind: "open_order", count: 1 }], storeName: "secret" })
        .success,
    ).toBe(false);
    expect(StoreArchiveParamsSchema.parse({ storeId: id })).toEqual({ storeId: id });
    for (const bad of [id.toUpperCase(), id.replace("abcd", "aBcd"), "bad"])
      expect(StoreArchiveParamsSchema.safeParse({ storeId: bad }).success).toBe(false);
    expect(StoreArchiveParamsSchema.safeParse({ storeId: id, force: true }).success).toBe(false);
  });
  it("正式路径/capability/required 幂等与400/401/403/404/409错误边界", () => {
    expect(mStoreArchive.path).toBe("/api/v1/m/stores/{storeId}/archive");
    expect(mStoreArchive.method).toBe("post");
    expect(mStoreArchive["x-capability"]).toBe("store.archive");
    expect(mStoreArchive["x-idempotent"]).toBe("required");
    expect(mStoreArchive["x-clerk-view"]).toBe("none");
    expect(Object.keys(mStoreArchive.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
    ]);
  });
});
