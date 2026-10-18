import { describe, expect, it } from "vitest";
import {
  InvitationCardSchema,
  InvitationCreateBodySchema,
  InvitationIdParamsSchema,
  InvitationLookupQuerySchema,
  InvitationMarkSharedResultSchema,
  InvitationPreviewSchema,
  InvitationRevokeBodySchema,
  InvitationRevokeResultSchema,
} from "./tenant.schemas.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const requestV4 = "123e4567-e89b-42d3-a456-426614174000";
const instant = "2026-10-11T00:00:00.000Z";
const token = "a".repeat(41) + "_-";
const card = {
  invitationId: id,
  token,
  isReused: false,
  role: "clerk",
  storeId: id,
  storeName: null,
  inviterName: "门店老板",
  remarkName: null,
  isPhoneRestricted: false,
  expiresAt: instant,
  seats: {
    seatsUsed: 1,
    memberLimit: null,
    pendingInvitationCount: 1,
    includesUnsharedDraft: true,
    seatsOver: 0,
    limitReason: "inactive",
    planName: null,
  },
};
const preview = {
  invitationId: id,
  status: "pending",
  storeName: null,
  city: null,
  category: null,
  inviterName: "门店老板",
  role: "clerk",
  isPhoneRestricted: false,
  expiresAt: instant,
};

describe("邀请卡片的严格契约", () => {
  it("客户端意图号接受小写 v4/v7，省略字段不被补成 null", () => {
    for (const clientRequestId of [requestV4, id]) {
      const value = { clientRequestId };
      const parsed = InvitationCreateBodySchema.parse(value);
      expect(parsed).toEqual(value);
      expect(Object.hasOwn(parsed, "remarkName")).toBe(false);
      expect(Object.hasOwn(parsed, "targetPhone")).toBe(false);
      expect(
        InvitationCreateBodySchema.parse({ ...value, remarkName: null, targetPhone: null }),
      ).toEqual({ ...value, remarkName: null, targetPhone: null });
    }
    for (const value of [
      {},
      { clientRequestId: id.toUpperCase() },
      { clientRequestId: "bad" },
      { clientRequestId: id, role: "clerk" },
      { clientRequestId: id, storeId: id },
    ])
      expect(InvitationCreateBodySchema.safeParse(value).success).toBe(false);
  });
  it("备注按十个 Unicode 码点约束，手机号不转换类型或裁剪空白", () => {
    for (const remarkName of ["", "🍜".repeat(10)])
      expect(InvitationCreateBodySchema.parse({ clientRequestId: id, remarkName }).remarkName).toBe(
        remarkName,
      );
    for (const patch of [
      { remarkName: "🍜".repeat(11) },
      { remarkName: 10 },
      { targetPhone: "23800138000" },
      { targetPhone: "1380013800" },
      { targetPhone: "138001380000" },
      { targetPhone: " 13800138000" },
      { targetPhone: 13800138000 },
    ])
      expect(InvitationCreateBodySchema.safeParse({ clientRequestId: id, ...patch }).success).toBe(
        false,
      );
    expect(
      InvitationCreateBodySchema.parse({ clientRequestId: id, targetPhone: "13800138000" }),
    ).toEqual({ clientRequestId: id, targetPhone: "13800138000" });
  });
  it("卡片完整保留十一字段和额度信息，拒绝缺项、敏感信息与错误类型", () => {
    expect(InvitationCardSchema.parse(card)).toEqual(card);
    expect(Object.keys(InvitationCardSchema.parse(card)).sort()).toEqual([
      "expiresAt",
      "invitationId",
      "inviterName",
      "isPhoneRestricted",
      "isReused",
      "remarkName",
      "role",
      "seats",
      "storeId",
      "storeName",
      "token",
    ]);
    for (const key of Object.keys(card)) {
      const missing: Record<string, unknown> = { ...card };
      delete missing[key];
      expect(InvitationCardSchema.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { role: "owner" },
      { inviterName: "" },
      { isReused: 1 },
      { isPhoneRestricted: "false" },
      { targetPhone: "13800138000" },
      { clientRequestId: id },
      { expiresAt: "2026-10-11T00:00:00Z" },
      { seats: { ...card.seats, seatsUsed: -1 } },
      { seats: { ...card.seats, pendingInvitationCount: 0.5 } },
    ])
      expect(InvitationCardSchema.safeParse({ ...card, ...patch }).success).toBe(false);
    expect(
      InvitationCardSchema.parse({
        ...card,
        storeName: "公开门店",
        remarkName: "",
        isReused: true,
      }),
    ).toMatchObject({ storeName: "公开门店", remarkName: "", isReused: true });
  });
  it("匿名预览严格九字段，四种状态均可读且不泄漏令牌、备注、额度与手机号", () => {
    for (const status of ["pending", "accepted", "revoked", "expired"])
      expect(InvitationPreviewSchema.parse({ ...preview, status })).toEqual({ ...preview, status });
    expect(Object.keys(InvitationPreviewSchema.parse(preview)).sort()).toEqual([
      "category",
      "city",
      "expiresAt",
      "invitationId",
      "inviterName",
      "isPhoneRestricted",
      "role",
      "status",
      "storeName",
    ]);
    for (const key of Object.keys(preview)) {
      const missing: Record<string, unknown> = { ...preview };
      delete missing[key];
      expect(InvitationPreviewSchema.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { token },
      { remarkName: "不得泄漏" },
      { seats: card.seats },
      { targetPhone: "13800138000" },
      { status: "unknown" },
      { inviterName: "" },
      { role: "owner" },
    ])
      expect(InvitationPreviewSchema.safeParse({ ...preview, ...patch }).success).toBe(false);
    const value = {
      ...preview,
      city: { code: "city", name: "公开城市" },
      category: { code: "cat", name: "公开类目" },
    };
    expect(InvitationPreviewSchema.parse(value)).toEqual(value);
  });
  it("匿名查询只接受完整四十三位 base64url 令牌，卡片复用同一校验", () => {
    expect(InvitationLookupQuerySchema.parse({ token })).toEqual({ token });
    for (const bad of [
      "",
      "a".repeat(42),
      "a".repeat(44),
      "a".repeat(42) + "=",
      "a".repeat(42) + "+",
      "a".repeat(42) + "/",
      " " + token,
      token + "\n",
      null,
    ]) {
      expect(InvitationLookupQuerySchema.safeParse({ token: bad }).success).toBe(false);
      expect(InvitationCardSchema.safeParse({ ...card, token: bad }).success).toBe(false);
    }
    for (const value of [{}, { token, invitationId: id }])
      expect(InvitationLookupQuerySchema.safeParse(value).success).toBe(false);
  });
  it("业务邀请 ID 保持小写 v7，不因客户端意图号放宽", () => {
    expect(InvitationIdParamsSchema.parse({ invitationId: id })).toEqual({ invitationId: id });
    for (const invitationId of [requestV4, id.toUpperCase(), id.replace("abcd", "aBcd"), "bad"]) {
      expect(InvitationIdParamsSchema.safeParse({ invitationId }).success).toBe(false);
      expect(InvitationCardSchema.safeParse({ ...card, invitationId }).success).toBe(false);
      expect(InvitationPreviewSchema.safeParse({ ...preview, invitationId }).success).toBe(false);
    }
    expect(InvitationIdParamsSchema.safeParse({ invitationId: id, token }).success).toBe(false);
  });
  it("分享回包保留显式 null，撤销只接受正式原因与终态时刻", () => {
    for (const sharedAt of [null, instant])
      expect(InvitationMarkSharedResultSchema.parse({ invitationId: id, sharedAt })).toEqual({
        invitationId: id,
        sharedAt,
      });
    for (const value of [
      { invitationId: id },
      { invitationId: id, sharedAt: "bad" },
      { invitationId: id, sharedAt: null, token },
    ])
      expect(InvitationMarkSharedResultSchema.safeParse(value).success).toBe(false);
    for (const reason of ["by_owner", "unshared_leave"])
      expect(InvitationRevokeBodySchema.parse({ reason })).toEqual({ reason });
    for (const value of [{}, { reason: "expired" }, { reason: "by_owner", invitationId: id }])
      expect(InvitationRevokeBodySchema.safeParse(value).success).toBe(false);
    const result = { invitationId: id, status: "revoked", revokedAt: instant };
    expect(InvitationRevokeResultSchema.parse(result)).toEqual(result);
    for (const patch of [
      { status: "pending" },
      { revokedAt: null },
      { revokedAt: "bad" },
      { token },
    ])
      expect(InvitationRevokeResultSchema.safeParse({ ...result, ...patch }).success).toBe(false);
    for (const key of Object.keys(result)) {
      const missing: Record<string, unknown> = { ...result };
      delete missing[key];
      expect(InvitationRevokeResultSchema.safeParse(missing).success).toBe(false);
    }
  });
});
