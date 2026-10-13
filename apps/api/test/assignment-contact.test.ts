import { beforeAll, describe, expect, it, vi } from "vitest";
import { AssignmentContactViewSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { harness } from "./admin-profile-fixtures.js";
import type { Harness } from "./admin-profile-fixtures.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi,
  h: Harness,
  manager: SignedInStaff,
  lead: SignedInStaff,
  admin: SignedInStaff,
  outsider: SignedInStaff;
let peer = 0;
beforeAll(async () => {
  api = await handle.start();
  h = harness(api, await handle.db.prisma());
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  manager = await signInAsStaff(h.prisma, { roleKey: "delivery_manager" });
  lead = await signInAsStaff(h.prisma, {
    roleKey: "delivery_manager",
    isLead: true,
    staffGroupId: manager.staff.staffGroupId,
  });
  admin = await signInAsStaff(h.prisma, { roleKey: "super_admin" });
  outsider = await signInAsStaff(h.prisma, { roleKey: "delivery_manager", staffGroupId: null });
}, 120000);
const path = (id: string) => `/api/v1/admin/assignment-histories/${id}/mark-contacted`;
const post = (id: string, staff = manager, key: string | null = uuidv7(), body: unknown = {}) =>
  api.request(path(id), {
    method: "POST",
    headers: {
      ...staff.headers,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
    peer: `198.19.212.${++peer}`,
  });
async function error(res: Response, status: number, symbol: string) {
  expect(res.status, await res.clone().text()).toBe(status);
  expect(await res.json()).toMatchObject({ error: symbol });
}
async function view(res: Response) {
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return AssignmentContactViewSchema.parse(((await res.json()) as { data: unknown }).data);
}
async function obligation(state: "pending" | "voided" = "pending") {
  const owner = await h.owner();
  await h.prisma.store.update({
    where: { id: owner.store.id },
    data: { deliveryManagerId: manager.staff.id },
  });
  const now = api.clock.now(),
    due = new Date(now.getTime() + 3600_000);
  const history = await h.prisma.assignmentHistory.create({
    data: {
      id: uuidv7(),
      batchId: uuidv7(),
      source: "store_manager",
      subjectType: "store",
      subjectId: owner.store.id,
      fromStaffId: outsider.staff.id,
      toStaffId: manager.staff.id,
      reasonCode: "reassigned",
      actorType: "system",
      contactDueAt: due,
      contactVoidedAt: state === "voided" ? now : null,
      slaSnapshot: {
        policy: "manager.first_contact",
        amount: 1,
        unit: "natural_hours",
        calendarVersion: 0,
        computedAt: now.toISOString(),
      },
      createdAt: now,
      updatedAt: now,
    },
  });
  await api.runtime.tx.run((tx) =>
    api.runtime.timers.arm(tx, {
      kind: "sla.breach",
      subject: { type: "assignment_history", id: history.id },
      fireAt: due,
      key: `sla.breach:assignment_history:${history.id}`,
      payload: { dueAt: due.toISOString() },
      entityId: owner.entity.id,
      storeId: owner.store.id,
    }),
  );
  return { ...owner, history };
}
describe("W2-11已联系商家实际HTTP", { timeout: 60000 }, () => {
  it("admin.assignmentHistory.markContacted 本人标记/同键重放一次审计并取消原SLA，旧键也复核现范围", async () => {
    expect(
      HANDLERS.some((h) => h.route.operationId === "admin.assignmentHistory.markContacted"),
    ).toBe(true);
    const g = await obligation(),
      key = uuidv7(),
      body = { note: "已通过企业微信联系商家" };
    const events = await h.prisma.outboxEvent.count();
    const result = await view(await post(g.history.id, manager, key, body));
    expect(result).toMatchObject({
      assignmentHistoryId: g.history.id,
      storeId: g.store.id,
      toStaff: { staffId: manager.staff.id },
      contactedBy: { staffId: manager.staff.id },
    });
    expect(result.contactedAt).toBe(api.clock.now().toISOString());
    expect(await view(await post(g.history.id, manager, key, body))).toEqual(result);
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: g.history.id, action: "staff.assignment.contact" },
      }),
    ).toBe(1);
    expect(await h.prisma.timer.findFirst({ where: { subjectId: g.history.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await h.prisma.outboxEvent.count()).toBe(events);
    await error(await post(g.history.id), 409, "STATE_NOT_ALLOWED");
    await h.prisma.store.update({
      where: { id: g.store.id },
      data: { deliveryManagerId: outsider.staff.id },
    });
    await error(await post(g.history.id, manager, key, body), 404, "NOT_FOUND");
  });
  it("同组主管允许，all不越过接收人授权，范围/required/非法状态拒绝零业务写", async () => {
    const g = await obligation();
    await error(await post(g.history.id, admin), 403, "PERMISSION_DENIED");
    await error(await post(g.history.id, outsider), 404, "NOT_FOUND");
    await error(await post(g.history.id, manager, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    await error(
      await post(g.history.id, manager, uuidv7(), { note: "长".repeat(201) }),
      400,
      "VALIDATION_FAILED",
    );
    await error(await post(uuidv7()), 404, "NOT_FOUND");
    const voided = await obligation("voided");
    await error(await post(voided.history.id), 409, "STATE_NOT_ALLOWED");
    expect(
      await h.prisma.assignmentHistory.findUnique({ where: { id: g.history.id } }),
    ).toMatchObject({ contactedAt: null });
    expect(await h.prisma.auditLog.count({ where: { targetId: g.history.id } })).toBe(0);
    expect((await view(await post(g.history.id, lead))).contactedBy?.staffId).toBe(lead.staff.id);
  });
  it("双连接不同键只一胜；取消时限故障回滚联系行/审计，原键可再次完成", async () => {
    const g = await obligation();
    const responses = await Promise.all([post(g.history.id), post(g.history.id, lead)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: g.history.id, action: "staff.assignment.contact" },
      }),
    ).toBe(1);
    const failed = await obligation(),
      key = uuidv7();
    const original = api.runtime.timers.cancel.bind(api.runtime.timers);
    const fault = vi.spyOn(api.runtime.timers, "cancel").mockImplementation(async (tx, input) => {
      const result = await original(tx, input);
      if (input.subject.id === failed.history.id) throw new Error("lyxtest contact cancel fault");
      return result;
    });
    try {
      expect((await post(failed.history.id, manager, key)).status).toBe(500);
    } finally {
      fault.mockRestore();
    }
    expect(
      await h.prisma.assignmentHistory.findUnique({ where: { id: failed.history.id } }),
    ).toMatchObject({ contactedAt: null });
    expect(
      await h.prisma.timer.findFirst({ where: { subjectId: failed.history.id } }),
    ).toMatchObject({ status: "scheduled" });
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: failed.history.id, action: "staff.assignment.contact" },
      }),
    ).toBe(0);
    await view(await post(failed.history.id, manager, key));
  });
});
