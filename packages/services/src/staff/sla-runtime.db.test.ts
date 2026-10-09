import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { assembleForTest, useSeededDatabase } from "../testing/index.js";
import { createStaffAssembly } from "./runtime.js";
import { fullStaffWorld } from "./__fixtures__/full.js";
import type { FullStaffWorld } from "./__fixtures__/full.js";
const SLOW = 180_000;
const db = useSeededDatabase("services", { label: "staffsla" });
let w: FullStaffWorld;
beforeAll(async () => {
  w = await fullStaffWorld(await db.prisma());
}, SLOW);
afterAll(() => w?.scope.close());
async function transferStore() {
  const from = await w.person("delivery_manager"),
    to = await w.person("delivery_manager");
  const store = await w.make.store({ deliveryManagerId: from.id });
  await w.service.handover(w.ctx, w.actor, from.id, {
    handoverToStaffId: to.id,
    reason: "reassigned",
  });
  const history = await w.prisma.assignmentHistory.findFirstOrThrow({
    where: { subjectId: store.id },
    orderBy: { seq: "desc" },
  });
  const timer = await w.prisma.timer.findFirstOrThrow({ where: { subjectId: history.id } });
  return { from, to, store, history, timer };
}
function recoverableScope() {
  let prior = 0;
  const base = assembleForTest({ entry: "api" });
  const copy = {
    ...base,
    recurringJobs: base.recurringJobs.map((r) =>
      r.kind === "notify.remind_scan"
        ? {
            ...r,
            run: async () => {
              prior++;
              return { handled: true };
            },
          }
        : r,
    ),
  };
  const scope = createStaffAssembly(copy);
  scope.attach(w.deps);
  return {
    scope,
    run: () =>
      scope.assembly.recurringJob("notify.remind_scan")!.run({ scheduledFor: w.clock.now() }),
    prior: () => prior,
  };
}
describe("员工联系时限与所属装配恢复", { timeout: SLOW }, () => {
  it("真实首次联系计时，未到/已联系/旧payload跳过；到期事件同事实只一份", async () => {
    const g = await transferStore();
    const handler = w.assembly.timerHandler("sla.breach")!;
    await w.prisma.timer.update({
      where: { id: g.timer.id },
      data: {
        status: "dispatched",
        dispatchNo: 1,
        leaseUntil: new Date(w.clock.now().getTime() + 60_000),
      },
    });
    const input = {
      id: g.timer.id,
      kind: "sla.breach",
      subjectType: "assignment_history",
      subjectId: g.history.id,
      payload: { dueAt: g.history.contactDueAt!.toISOString() },
    };
    expect(await w.tx.run((tx) => handler.handle(tx, input))).toBe("skipped");
    w.clock.set(new Date(g.history.contactDueAt!.getTime() + 1));
    expect(
      await w.tx.run((tx) =>
        handler.handle(tx, { ...input, payload: { dueAt: "2000-01-01T00:00:00.000Z" } }),
      ),
    ).toBe("skipped");
    expect(await w.tx.run((tx) => handler.handle(tx, input))).toBe("fired");
    expect(await w.tx.run((tx) => handler.handle(tx, input))).toBe("fired");
    expect(
      await w.prisma.outboxEvent.count({
        where: { eventType: "assignment.sla_breached", aggregateId: g.history.id },
      }),
    ).toBe(1);
    await w.prisma.assignmentHistory.update({
      where: { id: g.history.id },
      data: { contactedAt: w.clock.now(), contactedByStaffId: g.to.id },
    });
    expect(await w.tx.run((tx) => handler.handle(tx, input))).toBe("skipped");
  });
  it("calendar.imported只重算受影响work SLA，旧事件不回退/不写状态历史", async () => {
    const g = await transferStore();
    const day = g.history.createdAt.toISOString().slice(0, 10);
    const { _max } = await w.prisma.workCalendarDay.aggregate({ _max: { calendarVersion: true } });
    const version = (_max.calendarVersion ?? 0) + 1;
    await w.prisma.workCalendarDay.upsert({
      where: { day: new Date(`${day}T00:00:00Z`) },
      create: {
        day: new Date(`${day}T00:00:00Z`),
        isWorkday: false,
        kind: "holiday",
        calendarVersion: version,
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      },
      update: { isWorkday: false, kind: "holiday", calendarVersion: version },
    });
    const event = {
      id: uuidv7(),
      type: "calendar.imported",
      payload: {
        v: 1,
        calendarVersion: version,
        year: Number(day.slice(0, 4)),
        changedDays: [day],
      },
    };
    const historyCount = await w.prisma.statusTransition.count();
    await w.tx.run((tx) => w.assembly.subscriber("staff.onCalendarImported")!.handle(tx, event));
    const after = await w.prisma.assignmentHistory.findUniqueOrThrow({
      where: { id: g.history.id },
    });
    expect(after.slaSnapshot).toMatchObject({ calendarVersion: version });
    expect(await w.prisma.statusTransition.count()).toBe(historyCount);
    await w.tx.run((tx) =>
      w.assembly
        .subscriber("staff.onCalendarImported")!
        .handle(tx, {
          ...event,
          payload: { ...event.payload, calendarVersion: Math.max(1, version - 1) },
        }),
    );
    expect(
      (await w.prisma.assignmentHistory.findUniqueOrThrow({ where: { id: g.history.id } }))
        .contactDueAt,
    ).toEqual(after.contactDueAt);
  });
  it("再次真实改派废止旧联系义务和旧timer，只有最新一条有效", async () => {
    const g = await transferStore();
    const third = await w.person("delivery_manager");
    await w.service.handover(w.ctx, w.actor, g.to.id, {
      handoverToStaffId: third.id,
      reason: "reassigned",
    });
    expect(
      (await w.prisma.assignmentHistory.findUniqueOrThrow({ where: { id: g.history.id } }))
        .contactVoidedAt,
    ).not.toBeNull();
    expect((await w.prisma.timer.findUniqueOrThrow({ where: { id: g.timer.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await w.prisma.assignmentHistory.count({
        where: { subjectId: g.store.id, contactedAt: null, contactVoidedAt: null },
      }),
    ).toBe(1);
  });
  it("相同sla.breach唯一handler分流assignment_history，其余subject仍原handler；两个scope关闭隔离", async () => {
    let prior = 0;
    const base = assembleForTest({ entry: "api" });
    const copy = {
      ...base,
      timerHandlers: base.timerHandlers.map((r) =>
        r.kind === "sla.breach"
          ? {
              ...r,
              handle: async () => {
                prior++;
                return "skipped" as const;
              },
            }
          : r,
      ),
    };
    const a = createStaffAssembly(copy),
      b = createStaffAssembly(copy);
    a.attach(w.deps);
    b.attach(w.deps);
    expect(a.assembly.timerHandlers.filter((r) => r.kind === "sla.breach")).toHaveLength(1);
    const input = {
      id: uuidv7(),
      kind: "sla.breach",
      subjectType: "approval_request",
      subjectId: uuidv7(),
      payload: null,
    };
    await w.tx.run((tx) => a.assembly.timerHandler("sla.breach")!.handle(tx, input));
    await a.close();
    await w.tx.run((tx) => b.assembly.timerHandler("sla.breach")!.handle(tx, input));
    expect(prior).toBe(2);
    await expect(
      w.tx.run((tx) =>
        a.assembly
          .timerHandler("sla.breach")!
          .handle(tx, { ...input, subjectType: "assignment_history" }),
      ),
    ).rejects.toThrow("员工运行时尚未绑定或已关闭");
    await b.close();
    expect(
      createIdentityContext({ actor: { type: "system", job: "staff.sla_breach" } }).actor.type,
    ).toBe("system");
  });
  it("提交后邀请失败仍持久invited，原扫描下一轮恢复三真实表并稳定去重", async () => {
    const row = await w.person("editor");
    const original = w.deps.sendWecomInvite!;
    w.deps.sendWecomInvite = async () => {
      throw new Error("injected_inbox_failure");
    };
    await w.service.inviteWecom(w.ctx, w.actor, row.id);
    expect(
      (await w.prisma.staff.findUniqueOrThrow({ where: { id: row.id } })).wecomBindStatus,
    ).toBe("invited");
    expect(
      await w.prisma.notification.count({
        where: { staffId: row.id, notifySceneKey: "s.wecom_invite" },
      }),
    ).toBe(0);
    w.deps.sendWecomInvite = original;
    const r = recoverableScope();
    await r.run();
    await r.run();
    expect(r.prior()).toBe(2);
    expect(
      await w.prisma.notification.count({
        where: { staffId: row.id, notifySceneKey: "s.wecom_invite" },
      }),
    ).toBe(1);
    expect(await w.prisma.staffMessage.count({ where: { staffId: row.id } })).toBe(1);
    expect(
      await w.prisma.notificationDelivery.count({
        where: { notification: { staffId: row.id }, channel: "inbox", status: "sent" },
      }),
    ).toBe(1);
    await r.scope.close();
  });
  it("超过100 invited按scope游标推进；前批去重不使第101人饥饿，重启安全", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const row = await w.person("editor");
      ids.push(row.id);
    }
    await w.prisma.staff.updateMany({
      where: { id: { in: ids } },
      data: { wecomBindStatus: "invited" },
    });
    const r = recoverableScope();
    await r.run();
    await r.run();
    expect(
      await w.prisma.notification.count({
        where: { staffId: { in: ids }, notifySceneKey: "s.wecom_invite" },
      }),
    ).toBe(101);
    await r.scope.close();
    const restarted = recoverableScope();
    await restarted.run();
    await restarted.run();
    expect(
      await w.prisma.notification.count({
        where: { staffId: { in: ids }, notifySceneKey: "s.wecom_invite" },
      }),
    ).toBe(101);
    await restarted.scope.close();
  });
  it("scope关闭等当前恢复TX完成，其他scope继续独立恢复", async () => {
    const row = await w.person("editor");
    await w.prisma.staff.update({ where: { id: row.id }, data: { wecomBindStatus: "invited" } });
    const original = w.deps.sendWecomInvite!;
    let entered!: () => void, release!: () => void;
    const start = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    w.deps.sendWecomInvite = async (input) => {
      entered();
      await gate;
      return original(input);
    };
    const r = recoverableScope();
    const running = r.run();
    await start;
    let finished = false;
    const closing = r.scope.close().then(() => {
      finished = true;
    });
    expect(finished).toBe(false);
    release();
    await Promise.all([running, closing]);
    w.deps.sendWecomInvite = original;
    expect(
      (await w.prisma.staff.findUniqueOrThrow({ where: { id: row.id } })).wecomBindStatus,
    ).toBe("invited");
    const other = recoverableScope();
    await other.run();
    await other.run();
    await other.scope.close();
    expect(
      await w.prisma.notification.count({
        where: { staffId: row.id, notifySceneKey: "s.wecom_invite" },
      }),
    ).toBe(1);
  });
});
