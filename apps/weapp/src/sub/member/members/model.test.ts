import { expect, it } from "vitest";
import { MemberListSchema, MemberUpdateBodySchema } from "@liyoxi/contract";
import { ApiError, type RequestLayer } from "@/lib/request";
import {
  TENANT_MEMBER,
  TENANT_SECOND,
  tenantMe,
  tenantMembers,
} from "../../../../shots/tenant-data";
import { createTenantApi } from "./api";
import { createTenantAction, currentMembership } from "./model";
it("成员编辑/移除/本人退出走正式目标与键；满范围校验、同意图失败重试及旧等待零调用", async () => {
  const owner = MemberListSchema.parse(tenantMembers()),
    clerk = MemberListSchema.parse(tenantMembers(true));
  expect(owner.viewerRole).toBe("owner");
  expect(clerk.viewerRole).toBe("clerk");
  expect(MemberUpdateBodySchema.safeParse({ storeIds: [] }).success).toBe(false);
  expect(
    MemberUpdateBodySchema.safeParse({ storeIds: [TENANT_SECOND, TENANT_SECOND] }).success,
  ).toBe(false);
  const calls: { path: string; options: Parameters<RequestLayer["request"]>[1] }[] = [];
  const call: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({ path, options });
    return {
      memberId: TENANT_MEMBER,
      status: "removed",
      removedAt: "2026-10-06T00:00:00.000Z",
    } as T;
  };
  const api = createTenantApi(call);
  await api.updateMember(TENANT_MEMBER, { storeIds: [TENANT_SECOND] }, "update:1");
  await api.removeMember(TENANT_MEMBER, "remove:1");
  await api.leave("leave:1");
  expect(calls.map((c) => c.path)).toEqual([
    `/m/members/${TENANT_MEMBER}`,
    `/m/members/${TENANT_MEMBER}/remove`,
    "/m/me/membership/leave",
  ]);
  expect(calls[0]?.options).toMatchObject({
    method: "PATCH",
    data: { storeIds: [TENANT_SECOND] },
    idempotencyKey: "update:1",
  });
  expect(currentMembership(tenantMe(true), TENANT_SECOND)?.role).toBe("clerk");
  expect(currentMembership(tenantMe(true), "outside")).toBeNull();
  let context = "old",
    keys = 0;
  const seen: string[] = [];
  const action = createTenantAction(
    () => context,
    () => `edit:${++keys}`,
  );
  const failed = async (key: string) => {
    seen.push(key);
    throw new ApiError({
      error: "NOT_A_MEMBER",
      message: "成员范围已变化",
      status: 403,
      requestId: "fixture",
    });
  };
  await action.run({ id: TENANT_MEMBER }, failed);
  await action.run({ id: TENANT_MEMBER }, failed);
  expect(seen).toEqual(["edit:1", "edit:1"]);
  expect(action.snapshot().error).toContain("成员范围已变化");
  let release!: () => void;
  const runtime = new Promise<void>((done) => {
    release = done;
  });
  const waiting = action.run({ sms: true }, async (_key, current) => {
    await runtime;
    if (!current()) return;
    await api.leave("must-not-call");
  });
  context = "new";
  action.invalidate();
  release();
  await waiting;
  expect(calls).toHaveLength(3);
  expect(action.snapshot().busy).toBe(false);
  action.dispose();
  expect(await action.run({}, async () => "late")).toBeUndefined();
});
