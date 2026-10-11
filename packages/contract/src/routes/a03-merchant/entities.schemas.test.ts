import { describe, expect, it } from "vitest";
import {
  EntityCardSchema,
  EntityStoreRowSchema,
  MemberRowSchema,
  MerchantUserBriefSchema,
  PendingInvitationRowSchema,
  EntityIdParamsSchema,
  EntityMemberListQuerySchema,
  EntityMemberListSchema,
  adminEntityGet,
  adminEntityMemberList,
} from "./index.js";

const id = "019a0000-0000-7000-8000-00000000000a",
  at = "2026-10-12T00:00:00.000Z";
const user = { merchantUserId: id, displayName: null, phoneMask: "139****2233", status: "active" };
const store = {
  storeId: id,
  name: null,
  isPrimary: true,
  lifecycle: "active",
  qualificationStatus: "unsubmitted",
  lastDecidedAt: null,
  reviewDueAt: null,
  openQualificationSubmissionId: null,
  address: { city: null, district: null, detail: null },
  deliveryManager: null,
  liveDramaCount: 0,
  producingDramaCount: 0,
  assetCount: 0,
  reviewedAssetCount: 0,
  copiedAssetCount: 0,
  copiedFromStoreId: null,
  clerkCount: 0,
  createdAt: at,
};
const member = {
  memberId: id,
  user,
  role: "owner",
  status: "active",
  storeIds: [],
  joinedAt: at,
  registeredAt: at,
  removedAt: null,
  removeReason: null,
  uploadedAssetCount: 0,
  adoptedAssetCount: 0,
  actions: [],
};
const invitation = {
  invitationId: id,
  storeId: id,
  remarkName: null,
  inviterName: null,
  createdAt: at,
  expiresAt: at,
};
const card = {
  entityId: id,
  name: null,
  entityType: null,
  lifecycle: "active",
  closedAt: null,
  verificationStatus: "unsubmitted",
  usccMask: null,
  legalRepNameMask: null,
  verifiedAt: null,
  sourceType: "organic",
  referralCode: null,
  createdAt: at,
  owner: user,
  subscription: {
    status: "none",
    plan: null,
    months: null,
    startDate: null,
    endDate: null,
    hasScheduledTerm: false,
    isRefundPending: false,
    latestPaymentOrder: null,
  },
  usage: {
    storesUsed: 1,
    storeLimit: 1,
    seatsUsed: 0,
    memberLimit: 3,
    storesOver: 0,
    seatsOver: 0,
    limitReason: "inactive",
    storeLimitOverride: null,
    memberLimitOverride: null,
    pendingInvitationCount: 0,
    activeMemberCount: 1,
    isOverLimit: false,
  },
  spendablePoints: 0,
  stores: [store],
  pendingInvitations: [invitation],
  lockVersion: 0,
  actions: [],
};

describe("后台主体严格输入与正式摘要", () => {
  it("两个原GET成为typed，保method/path/operation与纯查询权限声明", () => {
    expect(adminEntityGet).toMatchObject({
      method: "get",
      path: "/admin/entities/{entityId}",
      operationId: "admin.entity.get",
      "x-permission": null,
      "x-idempotent": "none",
    });
    expect(adminEntityMemberList).toMatchObject({
      method: "get",
      path: "/admin/entities/{entityId}/members",
      operationId: "admin.entity.member.list",
      "x-permission": null,
      "x-idempotent": "none",
    });
    expect(adminEntityGet.request?.params).toBe(EntityIdParamsSchema);
    expect(adminEntityMemberList.request?.query).toBe(EntityMemberListQuerySchema);
  });

  it("只收storeId/role/includeRemoved；缺省false，显式字符串boolean严格转换", () => {
    expect(EntityMemberListQuerySchema.parse({})).toEqual({ includeRemoved: false });
    expect(
      EntityMemberListQuerySchema.parse({ storeId: id, role: "clerk", includeRemoved: "true" }),
    ).toEqual({ storeId: id, role: "clerk", includeRemoved: true });
    expect(EntityMemberListQuerySchema.parse({ includeRemoved: "false" })).toEqual({
      includeRemoved: false,
    });
    expect(EntityIdParamsSchema.parse({ entityId: id })).toEqual({ entityId: id });
  });

  it.each([
    { page: "1" },
    { role: "admin" },
    { includeRemoved: true },
    { includeRemoved: "1" },
    { storeId: "bad" },
    { storeId: id.toUpperCase() },
    { entityId: id },
    { scope: "all" },
  ])("严格query拒绝 %j", (input) => {
    expect(EntityMemberListQuerySchema.safeParse(input).success).toBe(false);
  });

  it.each([{ entityId: "bad" }, { entityId: id, scope: "all" }, {}])("路径严格拒绝 %j", (input) => {
    expect(EntityIdParamsSchema.safeParse(input).success).toBe(false);
  });

  it("完整nullable键与不限名额、终态/未知枚举均可表示，成员列表没有分页", () => {
    expect(EntityCardSchema.parse(card)).toEqual(card);
    expect(
      EntityCardSchema.parse({
        ...card,
        owner: null,
        lifecycle: "future_state",
        usage: { ...card.usage, memberLimit: null },
      }),
    ).toMatchObject({ owner: null, lifecycle: "future_state", usage: { memberLimit: null } });
    expect(EntityMemberListSchema.parse({ items: [member] })).toEqual({ items: [member] });
    expect(EntityMemberListSchema.safeParse({ items: [], total: 0 }).success).toBe(false);
    expect(PendingInvitationRowSchema.parse(invitation)).toEqual(invitation);
    expect(EntityStoreRowSchema.parse(store)).toEqual(store);
  });

  it.each(["owner", "closedAt", "referralCode", "pendingInvitations", "lockVersion"])(
    "必有nullable或数组键%s不能缺省",
    (key) => {
      const input: Record<string, unknown> = { ...card };
      delete input[key];
      expect(EntityCardSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each(["phoneEnc", "phoneBidx", "phone", "openid", "avatarFileId"])(
    "账号概要拒绝敏感或未声明字段%s",
    (key) => {
      expect(MerchantUserBriefSchema.safeParse({ ...user, [key]: "不可泄露" }).success).toBe(false);
      expect(
        MemberRowSchema.safeParse({ ...member, user: { ...user, [key]: "不可泄露" } }).success,
      ).toBe(false);
      expect(
        EntityCardSchema.safeParse({ ...card, owner: { ...user, [key]: "不可泄露" } }).success,
      ).toBe(false);
    },
  );

  it.each(["usccEnc", "legalRepNameEnc", "contactPhoneEnc", "fileUrl", "fullProfile"])(
    "主体和门店概要拒绝%s",
    (key) => {
      expect(EntityCardSchema.safeParse({ ...card, [key]: "不可泄露" }).success).toBe(false);
      expect(EntityStoreRowSchema.safeParse({ ...store, [key]: "不可泄露" }).success).toBe(false);
    },
  );

  it.each(["token", "tokenEnc", "tokenHash", "targetPhoneBidx", "requestId"])(
    "待接受邀请不含%s",
    (key) => {
      expect(
        PendingInvitationRowSchema.safeParse({ ...invitation, [key]: "不可泄露" }).success,
      ).toBe(false);
    },
  );

  it.each([-1, 0.5, NaN])("所有计数拒绝非法数%s，不能靠输出补零", (value) => {
    expect(EntityStoreRowSchema.safeParse({ ...store, assetCount: value }).success).toBe(false);
    expect(MemberRowSchema.safeParse({ ...member, uploadedAssetCount: value }).success).toBe(false);
    expect(EntityCardSchema.safeParse({ ...card, spendablePoints: value }).success).toBe(false);
  });
});
