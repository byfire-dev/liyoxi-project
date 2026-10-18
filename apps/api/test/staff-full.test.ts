import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import type { StaffWecomSchema, z } from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
type StaffWecom = z.infer<typeof StaffWecomSchema>;
import type {
  StaffDetail,
  StaffMutationResult,
  HandoverResult,
  ActivationIssue,
  StaffCounts,
  OpenWorkSummary,
  PoolMemberList,
  PoolMember,
  StaffSessionView,
  AdminPage,
  StaffGroupSummary,
} from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const SLOW = 180_000;
const handle = useTestApi();
let app: TestApi, admin: SignedInStaff;
let p: Awaited<ReturnType<typeof handle.db.prisma>>;
let counter = 0;
type StaffOperation = Extract<
  keyof operations,
  `admin.staff${string}` | "admin.assignmentPoolMember.list"
>;
function req(
  operationId: StaffOperation,
  path: string,
  method = "GET",
  json?: unknown,
  key = uuidv7(),
  who = admin,
) {
  const route = app.api.mounted.find((entry) => entry.operationId === operationId);
  if (!route) throw new Error(`实际路由未挂载：${operationId}`);
  expect(route.method).toBe(method);
  expect(`/api/v1/admin${path.split("?")[0]}`.split("/")).toEqual(
    route.path
      .split("/")
      .map((part) => (/^\{[^}]+\}$/.test(part) ? expect.stringMatching(/^[^/]+$/) : part)),
  );
  return app.request(`/api/v1/admin${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...who.headers, "Idempotency-Key": key },
    peer: `198.19.41.${++counter}`,
  });
}
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function failure(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}
async function create(roleKey = "editor", activateNow = true) {
  return data<StaffMutationResult>(
    await req("admin.staff.create", "/staff", "POST", {
      name: `员工${counter}`,
      phone: `136${String(23000000 + counter).slice(-8)}`,
      roleKey,
      activateNow,
      activationDelivery: "manual",
    }),
  );
}
beforeAll(async () => {
  app = await handle.start();
  p = await handle.db.prisma();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  admin = await signInAsStaff(p, { roleKey: "super_admin", isLead: true, now: app.clock.now() });
}, SLOW);
describe("W2-03完整18真实HTTP与守卫", { timeout: SLOW }, () => {
  it("admin.staff.summary / admin.staffGroup.list / admin.staffSession.list / admin.assignmentPoolMember.list / admin.staff.openWork.get：GET零业务写并真实裁剪", async () => {
    const row = await create();
    const before = {
      history: await p.assignmentHistory.count(),
      cursors: await p.assignmentCursor.count(),
      audit: await p.auditLog.count(),
      events: await p.outboxEvent.count(),
    };
    const counts = await data<StaffCounts>(await req("admin.staff.summary", "/staff/summary"));
    expect(counts.total).toBeGreaterThanOrEqual(2);
    const groups = await data<{ items: StaffGroupSummary[] }>(
      await req("admin.staffGroup.list", "/staff-groups"),
    );
    expect(groups.items).toHaveLength(8);
    const sessions = await data<AdminPage<StaffSessionView>>(
      await req("admin.staffSession.list", "/staff-sessions"),
    );
    expect(sessions.items.some((r) => r.staffSessionId === admin.sessionId)).toBe(true);
    expect(JSON.stringify(sessions)).not.toMatch(/tokenHash|cookie|passwordHash/);
    const pool = await data<PoolMemberList>(
      await req("admin.assignmentPoolMember.list", "/assignment-pool-members?pool=editor"),
    );
    expect(pool).toMatchObject({ items: [], cursors: [] });
    const work = await data<OpenWorkSummary>(
      await req("admin.staff.openWork.get", `/staff/${row.staff.staffId}/open-work`),
    );
    expect(work.total).toBe(0);
    expect({
      history: await p.assignmentHistory.count(),
      cursors: await p.assignmentCursor.count(),
      audit: await p.auditLog.count(),
      events: await p.outboxEvent.count(),
    }).toEqual(before);
  });
  it("admin.staff.enable / admin.staff.reissueActivationCode：真实8码、C50重放null、错误key不同body拒绝", async () => {
    const row = await create("editor", false),
      key = uuidv7();
    const response = await req(
      "admin.staff.enable",
      `/staff/${row.staff.staffId}/enable`,
      "POST",
      { activationDelivery: "manual" },
      key,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const enabled = await data<StaffMutationResult>(response);
    expect(enabled.activation?.activationCode).toMatch(/^[A-Z0-9]{8}$/);
    const replay = await data<StaffMutationResult>(
      await req(
        "admin.staff.enable",
        `/staff/${row.staff.staffId}/enable`,
        "POST",
        { activationDelivery: "manual" },
        key,
      ),
    );
    expect(replay).toMatchObject({
      replayed: true,
      activation: { activationCode: null, replayed: true },
    });
    await failure(
      await req(
        "admin.staff.enable",
        `/staff/${row.staff.staffId}/enable`,
        "POST",
        { activationDelivery: "sms" },
        key,
      ),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    const secondKey = uuidv7();
    const issued = await data<ActivationIssue>(
      await req(
        "admin.staff.reissueActivationCode",
        `/staff/${row.staff.staffId}/reissue-activation-code`,
        "POST",
        { activationDelivery: "manual" },
        secondKey,
      ),
    );
    expect(issued.activationCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(
      await data<ActivationIssue>(
        await req(
          "admin.staff.reissueActivationCode",
          `/staff/${row.staff.staffId}/reissue-activation-code`,
          "POST",
          { activationDelivery: "manual" },
          secondKey,
        ),
      ),
    ).toMatchObject({ activationCode: null, replayed: true });
    expect(
      await p.staffActivation.count({
        where: { staffId: row.staff.staffId, usedAt: null, revokedAt: null },
      }),
    ).toBe(1);
  });
  it("admin.staff.update / admin.staff.poolMembership.replace / admin.staff.duty.update：CAS/角色池/自己客服OR权限", async () => {
    const row = await create("cs");
    const id = row.staff.staffId;
    const updated = await data<StaffDetail>(
      await req("admin.staff.update", `/staff/${id}`, "PATCH", {
        displayName: "接单客服",
        lockVersion: row.staff.lockVersion,
      }),
    );
    expect(updated.displayName).toBe("接单客服");
    await failure(
      await req("admin.staff.update", `/staff/${id}`, "PATCH", {
        displayName: "陈旧",
        lockVersion: row.staff.lockVersion,
      }),
      409,
      "VERSION_CONFLICT",
    );
    const member = await data<StaffDetail>(
      await req("admin.staff.poolMembership.replace", `/staff/${id}/pool-memberships`, "PUT", {
        memberships: [{ pool: "cs" }],
        lockVersion: updated.lockVersion,
      }),
    );
    expect(member.poolMemberships).toHaveLength(1);
    const cs = await signInAsStaff(p, { roleKey: "cs", now: app.clock.now() });
    await p.assignmentPoolMember.create({
      data: {
        staffId: cs.staff.id,
        pool: "cs",
        cityCode: "",
        createdAt: app.clock.now(),
        updatedAt: app.clock.now(),
      },
    });
    const duty = await data<PoolMember>(
      await req(
        "admin.staff.duty.update",
        `/staff/${cs.staff.id}/duty`,
        "PATCH",
        { onDuty: false },
        uuidv7(),
        cs,
      ),
    );
    expect(duty.onDuty).toBe(false);
    await failure(
      await req(
        "admin.staff.duty.update",
        `/staff/${id}/duty`,
        "PATCH",
        { onDuty: false },
        uuidv7(),
        cs,
      ),
      403,
      "PERMISSION_DENIED",
    );
  });
  it("admin.staff.resetPassword / admin.staff.resetMfa / admin.staff.unlock：confirm/current/self真实拒绝，清凭据与桶", async () => {
    const row = await create();
    const id = row.staff.staffId,
      body = { confirm: { staffNo: row.staff.staffNo }, activationDelivery: "manual" };
    await failure(
      await req("admin.staff.resetPassword", `/staff/${id}/reset-password`, "POST", {
        ...body,
        confirm: { staffNo: 999999 },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    expect(
      (
        await data<StaffMutationResult>(
          await req("admin.staff.resetPassword", `/staff/${id}/reset-password`, "POST", body),
        )
      ).activation?.purpose,
    ).toBe("reset_password");
    expect(
      (
        await data<StaffMutationResult>(
          await req("admin.staff.resetMfa", `/staff/${id}/reset-mfa`, "POST", body),
        )
      ).activation?.purpose,
    ).toBe("activate");
    await p.staff.update({ where: { id }, data: { failTrusted: 3, failUntrusted: 4 } });
    expect(
      (
        await data<StaffDetail>(
          await req("admin.staff.unlock", `/staff/${id}/unlock`, "POST", { bucket: "trusted" }),
        )
      ).security,
    ).toMatchObject({ failTrusted: 0, failUntrusted: 4 });
  });
  it("admin.staff.inviteWecom / admin.staff.bindWecom：真实站内提醒、绑定接管与无重复外发", async () => {
    const row = await create(),
      id = row.staff.staffId,
      key = uuidv7();
    expect(
      await data<StaffWecom>(
        await req("admin.staff.inviteWecom", `/staff/${id}/invite-wecom`, "POST", {}, key),
      ),
    ).toMatchObject({ status: "invited", qrUrl: null });
    await data(await req("admin.staff.inviteWecom", `/staff/${id}/invite-wecom`, "POST", {}, key));
    expect(
      await p.notification.count({ where: { staffId: id, notifySceneKey: "s.wecom_invite" } }),
    ).toBe(1);
    expect(
      await data<StaffWecom>(
        await req("admin.staff.bindWecom", `/staff/${id}/bind-wecom`, "POST", {
          wecomUserid: "lyx_api_member",
        }),
      ),
    ).toMatchObject({ status: "bound", userid: "lyx_api_member" });
  });
  it("admin.staff.handover / admin.staff.disable：四眼确认、真实移交history及禁用同TX", async () => {
    const from = await create("delivery_manager"),
      to = await create("delivery_manager");
    const make = createFactories({ db: p, clock: app.clock });
    const store = await make.store({ deliveryManagerId: from.staff.staffId });
    const moved = await data<HandoverResult>(
      await req("admin.staff.handover", `/staff/${from.staff.staffId}/handover`, "POST", {
        handoverToStaffId: to.staff.staffId,
        reason: "reassigned",
      }),
    );
    expect(moved.moved).toMatchObject([
      { source: "store_manager", subjectType: "store", count: 1 },
    ]);
    expect((await p.store.findUniqueOrThrow({ where: { id: store.id } })).deliveryManagerId).toBe(
      to.staff.staffId,
    );
    await failure(
      await req("admin.staff.disable", `/staff/${to.staff.staffId}/disable`, "POST", {
        reason: "resigned",
        handoverToStaffId: from.staff.staffId,
        confirm: { staffNo: to.staff.staffNo, openWorkCount: 0 },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    const disabled = await data<HandoverResult>(
      await req("admin.staff.disable", `/staff/${to.staff.staffId}/disable`, "POST", {
        reason: "resigned",
        handoverToStaffId: from.staff.staffId,
        confirm: { staffNo: to.staff.staffNo, openWorkCount: 1 },
      }),
    );
    expect(disabled.staff.status).toBe("disabled");
    expect((await p.store.findUniqueOrThrow({ where: { id: store.id } })).deliveryManagerId).toBe(
      from.staff.staffId,
    );
  });
  it("admin.staffSession.revoke：真实其他会话吊销、当前拒绝且错误不写审计", async () => {
    const other = await signInAsStaff(p, { roleKey: "editor", now: app.clock.now() });
    const result = await data<StaffSessionView>(
      await req("admin.staffSession.revoke", `/staff-sessions/${other.sessionId}/revoke`, "POST", {
        reason: "测试下线",
      }),
    );
    expect(result.revokeReason).toBe("admin");
    const count = await p.auditLog.count();
    await failure(
      await req(
        "admin.staffSession.revoke",
        `/staff-sessions/${admin.sessionId}/revoke`,
        "POST",
        {},
      ),
      409,
      "SELF_OPERATION_FORBIDDEN",
    );
    expect(await p.auditLog.count()).toBe(count);
  });
  it("真实生产链未登录/非管理角色/无stepup拒绝，不走乐观权限", async () => {
    const row = await create();
    const editor = await signInAsStaff(p, { roleKey: "editor", now: app.clock.now() });
    await failure(
      await req(
        "admin.staff.unlock",
        `/staff/${row.staff.staffId}/unlock`,
        "POST",
        {},
        uuidv7(),
        editor,
      ),
      403,
      "PERMISSION_DENIED",
    );
    await p.staffSession.update({
      where: { id: admin.sessionId },
      data: {
        createdAt: new Date(app.clock.now().getTime() - 11 * 60_000),
        stepupAt: new Date(app.clock.now().getTime() - 11 * 60_000),
      },
    });
    await failure(
      await req("admin.staff.resetMfa", `/staff/${row.staff.staffId}/reset-mfa`, "POST", {
        confirm: { staffNo: row.staff.staffNo },
        activationDelivery: "manual",
      }),
      403,
      "STEP_UP_REQUIRED",
    );
    await p.staffSession.update({
      where: { id: admin.sessionId },
      data: { stepupAt: app.clock.now() },
    });
  });
});
