// Private live-server adapter only. These receipts test forwarding, not real authentication
// or database ownership; the live suite supplies those independent facts.
import { ADMIN_MODULE_KEYS, IdSchema, StaffMeSchema } from "@liyoxi/contract";
import { W608LiveScopeSchema } from "@liyoxi/services/testing";
import { describe, expect, it, vi } from "vitest";
import { handleW608LiveControl } from "./w608-live-control.js";

const id = (n: number) => `019aa000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const origin = "http://127.0.0.1:4608";
const scope = W608LiveScopeSchema.parse({
  runId: "1234567890abcdef",
  name: "lyx_test_admin_live_1234567890abcdef",
  prefix: "lyx:test:admin_live_1234567890abcdef:",
  startedAt: "2026-11-04T01:00:00.000Z",
  entityId: id(1),
  storeId: id(2),
  orderId: id(3),
  itemId: id(4),
  ticketId: id(5),
  uploaderId: id(6),
  managerId: id(7),
  dramaId: id(8),
  planId: id(9),
  merchantUserId: id(10),
  memberId: id(11),
  posterFileId: id(12),
  accountIds: [id(13), id(14)],
  foreign: { entityId: id(15), storeId: id(16), accountId: id(17) },
});
const me = StaffMeSchema.parse({
  staff: {
    staffId: scope.uploaderId,
    staffNo: 1001,
    name: "虚构验收上传员",
    roleKey: "super_admin",
    isLead: false,
    status: "active",
  },
  displayName: null,
  phoneMask: "138****0000",
  roleName: "超级管理员",
  staffGroup: null,
  moduleLevels: Object.fromEntries(ADMIN_MODULE_KEYS.map((key) => [key, "e"])),
  permissions: [],
  dataScope: "all",
  wecomBindStatus: "none",
  mustChangePassword: false,
  recoveryCodesLeft: 10,
  session: {
    staffSessionId: id(18),
    authMethod: "password+totp",
    idleExpiresAt: "2026-11-04T02:00:00.000Z",
    absoluteExpiresAt: "2026-11-04T09:00:00.000Z",
    stepUpValidUntil: "2026-11-04T01:10:00.000Z",
  },
  flags: {},
  serverTime: "2026-11-04T01:01:00.000Z",
});
const authReceipt = (data: unknown = me) => Response.json({ code: 0, message: "ok", data });
const fileReceipt = { fileId: IdSchema.parse(id(19)) };
function request(
  options: { method?: string; raw?: string; origin?: string | null; admin?: string | null } = {},
) {
  const method = options.method ?? "POST";
  const headers = new Headers({
    Origin: origin,
    "X-LYX-Admin": "1",
    "Content-Type": "application/json",
    "Content-Length": "26",
    "Transfer-Encoding": "chunked",
    Cookie: "lyx_admin=synthetic-session-only",
    "X-Request-Id": "w608-forwarding-test",
  });
  if (options.origin === null) headers.delete("Origin");
  else if (options.origin !== undefined) headers.set("Origin", options.origin);
  if (options.admin === null) headers.delete("X-LYX-Admin");
  else if (options.admin !== undefined) headers.set("X-LYX-Admin", options.admin);
  return new Request(`${origin}/api/v1/__test/w608/control`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: options.raw ?? JSON.stringify({ action: "upload_sample" }) }),
  });
}
function harness() {
  return {
    scope,
    closing: false,
    controller: { run: vi.fn(async (_raw: unknown) => fileReceipt) },
    fetch: vi.fn(async (_request: Request) => authReceipt()),
  };
}
async function rejected(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: "W608_CONTROL_REJECTED" });
}

describe("W608 private control authentication boundary", () => {
  it("无scope或无controller拒绝，关闭中拒绝；均不读取身份或执行命令", async () => {
    for (const patch of [{ scope: undefined }, { controller: undefined }, { closing: true }]) {
      const h = harness();
      await rejected(
        await handleW608LiveControl({ ...h, ...patch, request: request() }),
        "closing" in patch ? 410 : 404,
      );
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.controller.run).not.toHaveBeenCalled();
    }
  });
  it.each(["GET", "HEAD", "PUT", "DELETE"])("%s不能进入控制器或触发认证转发", async (method) => {
    const h = harness();
    await rejected(await handleW608LiveControl({ ...h, request: request({ method }) }), 405);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.controller.run).not.toHaveBeenCalled();
  });
  it.each([
    { origin: null },
    { origin: "https://foreign.example.invalid" },
    { origin: "http://127.0.0.1:4609" },
    { admin: null },
    { admin: "0" },
  ])("同源与后台请求标记必须同时匹配：%j", async (headers) => {
    const h = harness();
    await rejected(await handleW608LiveControl({ ...h, request: request(headers) }), 403);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.controller.run).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])("认证读口HTTP%d不放行命令", async (status) => {
    const h = harness();
    h.fetch.mockResolvedValue(Response.json({ error: "AUTH_REQUIRED" }, { status }));
    await rejected(await handleW608LiveControl({ ...h, request: request() }), 403);
    expect(h.controller.run).not.toHaveBeenCalled();
  });
  it("有效StaffMe属于另一actor也拒绝，包括本scope的manager", async () => {
    for (const staffId of [scope.managerId, id(90)]) {
      const h = harness();
      const other = StaffMeSchema.parse({ ...me, staff: { ...me.staff, staffId } });
      h.fetch.mockResolvedValue(authReceipt(other));
      await rejected(await handleW608LiveControl({ ...h, request: request() }), 403);
      expect(h.controller.run).not.toHaveBeenCalled();
    }
  });
  it("不能用仅staffId、缺session或缺模块的伪me收据冒充完整契约", async () => {
    for (const incomplete of [
      { staff: { staffId: scope.uploaderId } },
      { ...me, session: undefined },
      { ...me, moduleLevels: { publish: "e" } },
      { ...me, staff: { staffId: scope.uploaderId } },
      null,
    ]) {
      expect(StaffMeSchema.safeParse(incomplete).success).toBe(false);
      const h = harness();
      h.fetch.mockResolvedValue(authReceipt(incomplete));
      await rejected(await handleW608LiveControl({ ...h, request: request() }), 403);
      expect(h.controller.run).not.toHaveBeenCalled();
    }
    const h = harness();
    h.fetch.mockResolvedValue(Response.json(me));
    await rejected(await handleW608LiveControl({ ...h, request: request() }), 403);
    expect(h.controller.run).not.toHaveBeenCalled();
  });
  it("完整StaffMe且本人uploader才执行，认证GET转发原Cookie并剥离正文头", async () => {
    const h = harness();
    const response = await handleW608LiveControl({ ...h, request: request() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: fileReceipt });
    expect(h.controller.run).toHaveBeenCalledExactlyOnceWith({ action: "upload_sample" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const forwarded = h.fetch.mock.calls[0]![0];
    expect(forwarded.url).toBe(`${origin}/api/v1/admin/auth/me`);
    expect(forwarded.method).toBe("GET");
    expect(await forwarded.text()).toBe("");
    expect(forwarded.headers.get("Cookie")).toBe("lyx_admin=synthetic-session-only");
    expect(forwarded.headers.get("Origin")).toBe(origin);
    expect(forwarded.headers.get("X-LYX-Admin")).toBe("1");
    for (const header of ["content-type", "content-length", "transfer-encoding"])
      expect(forwarded.headers.has(header)).toBe(false);
  });
  it.each([
    { action: "upload_sample", ticketId: scope.foreign.storeId },
    { action: "upload_sample", target: { ticketId: scope.ticketId } },
    { action: "upload_sample", extra: true },
    { action: "delete_all" },
    { action: ["upload_sample"] },
    {},
    null,
  ])("认证后仍拒绝任意target、额外字段和未知动作：%j", async (body) => {
    const h = harness();
    await rejected(
      await handleW608LiveControl({ ...h, request: request({ raw: JSON.stringify(body) }) }),
      400,
    );
    expect(h.controller.run).not.toHaveBeenCalled();
  });
  it("非法命令JSON不会执行控制器", async () => {
    const h = harness();
    await rejected(await handleW608LiveControl({ ...h, request: request({ raw: "{" }) }), 400);
    expect(h.controller.run).not.toHaveBeenCalled();
  });
  it("controller内部异常只返回稳定拒绝，不泄漏内部错误", async () => {
    const h = harness();
    h.controller.run.mockRejectedValue(new Error("synthetic-sensitive-internal-marker"));
    await rejected(await handleW608LiveControl({ ...h, request: request() }), 409);
  });
  it("认证转发异常与坏JSON也受控拒绝，不让内部异常逃出adapter", async () => {
    const failedFetch = harness();
    failedFetch.fetch.mockRejectedValue(new Error("synthetic-sensitive-auth-marker"));
    await rejected(await handleW608LiveControl({ ...failedFetch, request: request() }), 403);
    expect(failedFetch.controller.run).not.toHaveBeenCalled();
    const malformed = harness();
    malformed.fetch.mockResolvedValue(new Response("synthetic-sensitive-invalid-json"));
    await rejected(await handleW608LiveControl({ ...malformed, request: request() }), 403);
    expect(malformed.controller.run).not.toHaveBeenCalled();
  });
});
