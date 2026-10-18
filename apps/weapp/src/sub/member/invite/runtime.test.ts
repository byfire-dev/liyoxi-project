import { expect, it } from "vitest";
import { ApiError, type RequestLayer } from "@/lib/request";
import { TENANT_ID, tenantInvitation } from "../../../../shots/tenant-data";
import { createTenantApi } from "../members/api";
import { createTenantAction } from "../members/model";
import { createInvitationFlow, invitationSharePath } from "./runtime";
it("邀请自然clientRequestId重试；只分享token、不推断accepted，未分享离开撤回及服务端异常保留", async () => {
  const card = tenantInvitation,
    calls: { path: string; options: Parameters<RequestLayer["request"]>[1] }[] = [];
  let fail = true;
  const call: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({ path, options });
    if (path === "/m/invitations" && fail) {
      fail = false;
      throw new ApiError({
        error: "SEAT_LIMIT_REACHED",
        message: "成员名额已满",
        status: 409,
        requestId: "fixture",
      });
    }
    return card as T;
  };
  const api = createTenantApi(call),
    action = createTenantAction(
      () => "owner",
      () => TENANT_ID,
    );
  const create = (clientRequestId: string) =>
    api.invite({ clientRequestId, remarkName: "晚班", targetPhone: "13900009000" });
  await action.run({ phone: "13900009000" }, create);
  expect(action.snapshot().error).toContain("成员名额已满");
  await action.run({ phone: "13900009000" }, create);
  const drafts = calls.filter((c) => c.path === "/m/invitations");
  expect(drafts[0]?.options?.data).toEqual(drafts[1]?.options?.data);
  expect(drafts[0]?.options).not.toHaveProperty("idempotencyKey");
  expect(invitationSharePath(card)).toBe(`/sub/member/join/index?token=${card.token}`);
  expect(invitationSharePath(card)).not.toMatch(/139|phone|remark/);
  const unshared = createInvitationFlow(api, () => "revoke:1");
  await unshared.leave(card);
  expect(calls.at(-1)?.options).toMatchObject({ data: { reason: "unshared_leave" } });
  const shared = createInvitationFlow(api, () => "shared:1");
  await shared.share(card);
  await shared.leave(card);
  expect(shared.shared()).toBe(true);
  expect(calls.filter((c) => c.path.endsWith("/mark-shared"))).toHaveLength(1);
  expect(calls.filter((c) => c.path.endsWith("/revoke"))).toHaveLength(1);
  expect(calls.some((c) => c.path.endsWith("/accept"))).toBe(false);
  await api.revoke(card.invitationId, "by_owner", "owner:revoke");
  expect(calls.at(-1)?.options).toMatchObject({ data: { reason: "by_owner" } });
});
