import { describe, expect, it } from "vitest";
import { InvitationAcceptBodySchema, MembershipResultSchema } from "./tenant.schemas.js";
import { mInvitationAccept } from "./invitations.js";

const token = "a".repeat(41) + "_-";
const id = "018fabcd-0000-7000-8000-000000000001";

describe("接受邀请正式请求与当前成员投影", () => {
  it("仅 token 必填，省略/null 不制造称呼，按二十 Unicode 码点裁剪空白后校验", () => {
    expect(InvitationAcceptBodySchema.parse({ token })).toEqual({ token });
    expect(InvitationAcceptBodySchema.parse({ token, displayName: null })).toEqual({
      token,
      displayName: null,
    });
    expect(
      InvitationAcceptBodySchema.parse({ token, displayName: ` ${"🍜".repeat(20)} ` }).displayName,
    ).toBe("🍜".repeat(20));
    for (const displayName of ["", "  ", "🍜".repeat(21), 20, {}, []])
      expect(InvitationAcceptBodySchema.safeParse({ token, displayName }).success).toBe(false);
  });
  it("严格正文不接协议、手机号、旧登录凭据或伪权限", () => {
    for (const patch of [
      { consents: [] },
      { phone: "13800138000" },
      { phoneCode: "code" },
      { invitationId: id },
      { entityId: id },
      { locksHeld: true },
      { role: "owner" },
    ])
      expect(InvitationAcceptBodySchema.safeParse({ token, ...patch }).success).toBe(false);
    for (const value of [
      {},
      null,
      { token: token + "\n" },
      { token: token.slice(1) },
      { token: "a".repeat(44) },
      { token: 123 },
    ])
      expect(InvitationAcceptBodySchema.safeParse(value).success).toBe(false);
  });
  it("正式路由保 user/same/required 三段声明，不要求门店上下文", () => {
    expect(mInvitationAccept).toMatchObject({
      method: "post",
      path: "/api/v1/m/invitations/{invitationId}/accept",
      operationId: "m.invitation.accept",
      "x-auth": "user",
      "x-clerk-view": "same",
      "x-idempotent": "required",
      "x-three-phase": true,
      "x-rate-limit": "m.invitation",
    });
  });
  it.each(["owner", "clerk"])("当前有效 %s 角色沿原 MembershipResult，不伪造新关系", (role) => {
    const result = {
      entityId: id,
      memberId: id,
      storeId: id,
      role,
      isNew: false,
      abandonedEntityId: null,
    };
    expect(MembershipResultSchema.parse(result)).toEqual(result);
    for (const key of Object.keys(result)) {
      const missing: Record<string, unknown> = { ...result };
      delete missing[key];
      expect(MembershipResultSchema.safeParse(missing).success).toBe(false);
    }
  });
});
