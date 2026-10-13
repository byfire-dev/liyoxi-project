import { expect, it } from "vitest";
import { InvitationPreviewSchema, MembershipResultSchema } from "@liyoxi/contract";
import { ApiError, type RequestLayer } from "@/lib/request";
import {
  TENANT_ID,
  TENANT_SECOND,
  TENANT_TOKEN,
  tenantAgreements,
  tenantMe,
  tenantPreview,
  tenantResult,
} from "../../../../shots/tenant-data";
import { createTenantApi } from "../members/api";
import {
  joinLogin,
  joinedLoginScope,
  ownsJoinedLogin,
  previewLabel,
  validInvitationToken,
} from "./runtime";
it("加入四终态/public范围、member_join当前同意与返回ID；切人/离页/额外切店不续作", async () => {
  expect(validInvitationToken(TENANT_TOKEN)).toBe(true);
  for (const token of ["", "A".repeat(42), "../".repeat(15)])
    expect(validInvitationToken(token)).toBe(false);
  for (const status of ["pending", "accepted", "revoked", "expired"] as const) {
    expect(InvitationPreviewSchema.parse(tenantPreview(status)).status).toBe(status);
    expect(previewLabel(status)).not.toBe("邀请不可用");
  }
  expect(previewLabel("unknown")).toBe("邀请不可用");
  const calls: { path: string; options: Parameters<RequestLayer["request"]>[1] }[] = [];
  const loginResult = {
    token: "lyxm_new",
    me: tenantMe(true),
    isNewUser: true,
    switchedFrom: null,
  };
  const call: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({ path, options });
    return (
      path.endsWith("phone-login")
        ? loginResult
        : path.endsWith("/accept")
          ? tenantResult
          : tenantPreview()
    ) as T;
  };
  const api = createTenantApi(call),
    consents = tenantAgreements.items.flatMap((a) =>
      a.currentVersion
        ? [
            {
              agreementKey: a.agreementKey,
              agreementVersionId: a.currentVersion.agreementVersionId,
            },
          ]
        : [],
    );
  await api.lookup(TENANT_TOKEN);
  expect(calls[0]?.options).toEqual({ auth: false, store: false });
  const input = {
    phoneCode: "wx_phone",
    agreed: true,
    consents,
    loginCode: async () => "wx_login",
    current: () => true,
  };
  await expect(joinLogin(api, { ...input, agreed: false })).rejects.toThrow("勾选");
  await expect(joinLogin(api, { ...input, current: () => false })).rejects.toThrow("页面已变化");
  expect(calls).toHaveLength(1);
  expect((await joinLogin(api, input)).token).toBe(loginResult.token);
  expect(calls.at(-1)?.options).toMatchObject({
    auth: false,
    store: false,
    data: { consentScene: "member_join", consents, loginCode: "wx_login", phoneCode: "wx_phone" },
  });
  const result = MembershipResultSchema.parse(
    await api.accept(TENANT_ID, { token: TENANT_TOKEN }, "accept:1"),
  );
  expect(result.storeId).toBe(TENANT_SECOND);
  expect(calls.at(-1)?.options).toMatchObject({ store: false, idempotencyKey: "accept:1" });
  const expected = {
    token: loginResult.token,
    ...joinedLoginScope(loginResult.me, { currentStoreId: null, contextRev: 3 }),
    pageGeneration: 2,
  };
  const actual = { ...expected, visible: true };
  expect(ownsJoinedLogin(expected, actual)).toBe(true);
  expect(expected.contextRev).toBe(4);
  expect(ownsJoinedLogin(expected, { ...actual, token: "different" })).toBe(false);
  expect(ownsJoinedLogin(expected, { ...actual, visible: false })).toBe(false);
  expect(ownsJoinedLogin(expected, { ...actual, pageGeneration: 3 })).toBe(false);
  expect(ownsJoinedLogin(expected, { ...actual, contextRev: 6 })).toBe(false);
  const stale = new ApiError({
    error: "AGREEMENT_VERSION_STALE",
    message: "协议已更新",
    status: 409,
    requestId: "fixture",
  });
  const failing = createTenantApi(async () => {
    throw stale;
  });
  await expect(joinLogin(failing, input)).rejects.toBe(stale);
  for (const symbol of [
    "INVITATION_NOT_FOR_YOU",
    "SEAT_LIMIT_REACHED",
    "PHONE_IN_OTHER_ENTITY",
  ] as const) {
    const error = new ApiError({
      error: symbol,
      message: symbol,
      status: 409,
      requestId: "fixture",
    });
    const denied = createTenantApi(async () => {
      throw error;
    });
    await expect(denied.accept(TENANT_ID, { token: TENANT_TOKEN }, "same:retry")).rejects.toBe(
      error,
    );
  }
  const abandoned = MembershipResultSchema.parse({ ...tenantResult, abandonedEntityId: TENANT_ID });
  expect(abandoned.abandonedEntityId).toBe(TENANT_ID);
});
