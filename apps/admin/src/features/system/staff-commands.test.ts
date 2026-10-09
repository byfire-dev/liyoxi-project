import createClient from "openapi-fetch";
import type { paths } from "@liyoxi/contract/types/admin";
import { expect, it } from "vitest";
import { sendStaffCommand, type StaffCommandDraft } from "./staff-commands";
import type { OpenWork } from "./staff-access";

const id = "01900000-0000-7000-8000-000000000001";
const staff = { staffId: id, staffNo: 1001, lockVersion: 7 };
const draft: StaffCommandDraft = {
  name: "员工甲",
  roleKey: "cs",
  isLead: false,
  staffGroupId: "",
  displayName: "小甲",
  servicePhone: "",
  ackNoLead: false,
  target: "01900000-0000-7000-8000-000000000002",
  reason: "other",
  note: "调岗交接",
  wecomUserid: "staff_a",
  takeOver: false,
  bucket: "all",
  delivery: "manual",
  memberships: [{ pool: "cs", cityCode: null }],
};
function capture() {
  const calls: { path: string; method: string; key: string | null; body: unknown }[] = [];
  const client = createClient<paths>({
    baseUrl: "http://w206.test",
    fetch: async (request: Request) => {
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        key: request.headers.get("Idempotency-Key"),
        body: await request.json().catch(() => undefined),
      });
      return Response.json({ code: 0, message: "ok", data: {} });
    },
  });
  return { services: { api: { client } }, calls };
}
it("编辑与池整体替换都发送实际lockVersion，手机号不成为编辑字段", async () => {
  const { services, calls } = capture();
  await sendStaffCommand(services, staff, "update", draft, "edit-key");
  await sendStaffCommand(services, staff, "pools", draft, "pool-key");
  expect(calls[0]).toMatchObject({
    method: "PATCH",
    key: "edit-key",
    body: { lockVersion: 7, name: "员工甲", roleKey: "cs" },
  });
  expect(calls[0]!.body).not.toHaveProperty("phone");
  expect(calls[1]).toMatchObject({
    method: "PUT",
    body: { lockVersion: 7, memberships: draft.memberships },
  });
});
it("禁用必须使用读取到的真实在办数与真实工号确认，未读取不提交", async () => {
  const { services, calls } = capture();
  await expect(sendStaffCommand(services, staff, "disable", draft, "disable-key")).rejects.toThrow(
    "在办摘要",
  );
  expect(calls).toHaveLength(0);
  const brief = {
    staffId: id,
    staffNo: 1001,
    name: "甲",
    roleKey: "cs",
    isLead: false,
    status: "active",
  };
  const work: OpenWork = {
    staff: brief,
    total: 3,
    bySource: [],
    candidates: [],
    pendingApprovalsAsRequester: 0,
  };
  await sendStaffCommand(services, staff, "disable", draft, "disable-key", work);
  expect(calls[0]).toMatchObject({
    body: {
      confirm: { staffNo: 1001, openWorkCount: 3 },
      handoverToStaffId: draft.target,
      reason: "other",
      note: "调岗交接",
    },
  });
});
it("重置两种安全状态及补发均保持manual交付和独立真实资源", async () => {
  const { services, calls } = capture();
  for (const action of ["reset-password", "reset-mfa", "reissue-activation-code"])
    await sendStaffCommand(services, staff, action, draft, `key-${action}`);
  expect(calls.map((call) => call.path)).toEqual(
    ["reset-password", "reset-mfa", "reissue-activation-code"].map(
      (action) => `/api/v1/admin/staff/${id}/${action}`,
    ),
  );
  for (const call of calls) expect(call.body).toMatchObject({ activationDelivery: "manual" });
  for (const call of calls.slice(0, 2))
    expect(call.body).toMatchObject({ confirm: { staffNo: 1001 } });
});
it("未知操作和移交离职原因不发HTTP；其他实际动作保持精确接口", async () => {
  const { services, calls } = capture();
  await expect(sendStaffCommand(services, staff, "future", draft, "x")).rejects.toThrow("未登记");
  await expect(
    sendStaffCommand(services, staff, "handover", { ...draft, reason: "resigned" }, "x"),
  ).rejects.toThrow("仅移交");
  expect(calls).toHaveLength(0);
  for (const action of ["enable", "unlock", "bind-wecom", "invite-wecom", "handover"])
    await sendStaffCommand(services, staff, action, draft, `key-${action}`);
  expect(calls.map((call) => call.path.split("/").at(-1))).toEqual([
    "enable",
    "unlock",
    "bind-wecom",
    "invite-wecom",
    "handover",
  ]);
  expect(calls[1]!.body).toEqual({ bucket: "all", note: "调岗交接" });
  expect(calls[2]!.body).toEqual({ wecomUserid: "staff_a", takeOver: false });
});
