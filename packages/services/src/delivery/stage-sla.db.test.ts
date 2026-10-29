import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { alertsOf, lockRows, uuidv7 } from "../kernel/index.js";
import { createTimers, runTimer, timerKey } from "../timers/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { calendarDate } from "@liyoxi/shared/time";
import { createCalendarAdmin, workHoursAt } from "../sla/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import {
  handleDeliveryStageSlaBreach,
  holdCancelReviewPauses,
  readCancelReviewHoldTargets,
  readCancelReviewPauseTargets,
  releaseCancelReviewPauses,
} from "./index.js";
import { findDeliveryViolations } from "./invariants.js";
import { cancellationCause, m5Service, prepared } from "./__fixtures__/m5.js";
const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
beforeEach(() => h.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(() => h?.unbind());
async function timed() {
  const o = await h.order(),
    id = o.deliveryTicketIds[0]!;
  const dueAt = h.clock.now(),
    snapshot = {
      policy: "ticket.assigning",
      amount: 1,
      unit: "work_days",
      calendarVersion: 1,
      computedAt: dueAt.toISOString(),
    };
  await h.prisma.deliveryTicket.update({ where: { id }, data: { stepDueAt: dueAt } });
  const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
    where: { deliveryTicketId: id, completedAt: null },
  });
  await h.prisma.deliveryTicketStage.update({
    where: { id: stage.id },
    data: { dueAt, slaSnapshot: snapshot },
  });
  const timers = createTimers({ assembly: h.assembly });
  const armed = await h.tx.run(async (tx) => {
    await lockRows(tx, "delivery_ticket", [id]);
    return timers.arm(tx, {
      kind: "sla.breach",
      subject: { type: "delivery_ticket_stage", id: stage.id },
      key: timerKey("sla.breach", { type: "delivery_ticket_stage", id: stage.id }),
      fireAt: dueAt,
      entityId: o.entity.id,
      storeId: o.store.id,
      payload: { ...snapshot, dueAt: dueAt.toISOString() },
    });
  });
  await h.prisma.timer.update({
    where: { id: armed.id },
    data: { status: "dispatched", dispatchNo: 1, leaseUntil: new Date(dueAt.getTime() + 60000) },
  });
  const input = {
    id: armed.id,
    kind: "sla.breach",
    subjectType: "delivery_ticket_stage",
    subjectId: stage.id,
    payload: { ...snapshot, dueAt: dueAt.toISOString() },
  };
  return { ...o, id, stage, armed, input, timers };
}
describe("阶段员工时限真实到点", { timeout: 60000 }, () => {
  it("runTimer 同事务置超期并发正式事件，重复投递不重复副作用", async () => {
    const o = await timed(),
      original = h.assembly.timerHandler("sla.breach")!;
    const assembly = {
      ...h.assembly,
      timerHandler: (kind: string) =>
        kind === "sla.breach"
          ? {
              ...original,
              handle: (
                tx: Parameters<typeof original.handle>[0],
                timer: Parameters<typeof original.handle>[1],
              ) => handleDeliveryStageSlaBreach(tx, h.deps, timer),
            }
          : h.assembly.timerHandler(kind),
    };
    const runner = {
      tx: h.tx,
      assembly,
      registry: o.timers.registry,
      clock: h.clock,
      alerts: alertsOf(h.assembly),
    };
    const ref = { timerId: o.armed.id, dispatchNo: 1, kind: "sla.breach" };
    expect(await runTimer(runner, ref)).toBe("fired");
    expect(
      (await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: o.stage.id } }))
        .isBreached,
    ).toBe(true);
    expect((await h.prisma.timer.findUniqueOrThrow({ where: { id: o.armed.id } })).status).toBe(
      "fired",
    );
    const events = await h.prisma.outboxEvent.findMany({
      where: { aggregateId: o.id, eventType: "ticket.sla_breached" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      v: 1,
      deliveryTicketId: o.id,
      deliveryTicketStageId: o.stage.id,
      step: "assigning",
      dueAt: h.clock.now().toISOString(),
    });
    expect(await runTimer(runner, ref)).toBe("stale");
    expect(await h.tx.run((tx) => handleDeliveryStageSlaBreach(tx, h.deps, o.input))).toBe(
      "skipped",
    );
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.id, eventType: "ticket.sla_breached" },
      }),
    ).toBe(1);
  });
  it.each([
    "paused",
    "completed",
    "early",
    "deadline_changed",
    "snapshot_changed",
    "cancelled",
  ] as const)("%s 不误标超期或发事件", async (state) => {
    const o = await timed();
    if (state === "paused")
      await h.prisma.deliveryTicket.update({
        where: { id: o.id },
        data: { pauseCount: 1, pausedAt: h.clock.now(), pauseRemainingMin: 0 },
      });
    if (state === "completed")
      await h.prisma.deliveryTicketStage.update({
        where: { id: o.stage.id },
        data: { completedAt: h.clock.now(), exitEvent: "ticket.assign" },
      });
    if (state === "early") h.clock.set(new Date(h.clock.now().getTime() - 1));
    if (state === "deadline_changed")
      await h.prisma.deliveryTicket.update({
        where: { id: o.id },
        data: { stepDueAt: new Date(h.clock.now().getTime() + 60000) },
      });
    if (state === "snapshot_changed") o.input.payload.calendarVersion++;
    if (state === "cancelled")
      await h.prisma.timer.update({ where: { id: o.armed.id }, data: { status: "cancelled" } });
    expect(await h.tx.run((tx) => handleDeliveryStageSlaBreach(tx, h.deps, o.input))).toBe(
      "skipped",
    );
    expect(
      (await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: o.stage.id } }))
        .isBreached,
    ).toBe(false);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.id, eventType: "ticket.sla_breached" },
      }),
    ).toBe(0);
  });
  it("事件写失败回滚超期事实；恢复后同次到点仍能成功", async () => {
    const o = await timed();
    await expect(
      h.tx.run((tx) =>
        handleDeliveryStageSlaBreach(
          tx,
          {
            ...h.deps,
            events: {
              emit: async () => {
                throw new Error("event failed");
              },
            },
          },
          o.input,
        ),
      ),
    ).rejects.toThrow("event failed");
    expect(
      (await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: o.stage.id } }))
        .isBreached,
    ).toBe(false);
    expect(await h.tx.run((tx) => handleDeliveryStageSlaBreach(tx, h.deps, o.input))).toBe("fired");
  });
  it("两正式 schema 拒绝缺键、错误枚举与额外键", () => {
    const resumed = {
      v: 1,
      deliveryTicketId: uuidv7(),
      orderItemId: uuidv7(),
      reason: "cancel_review",
      refId: uuidv7(),
      fromState: "assigning",
      toState: "assigning",
      transition: "ticket.resume",
    };
    const breach = {
      v: 1,
      deliveryTicketId: uuidv7(),
      deliveryTicketStageId: uuidv7(),
      step: "assigning",
      dueAt: h.clock.now().toISOString(),
    };
    expect(EVENT_PAYLOAD_SCHEMAS["ticket.resumed"].safeParse(resumed).success).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS["ticket.resumed"].safeParse({ ...resumed, reason: "other" }).success,
    ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["ticket.resumed"].safeParse({ ...resumed, refType: "approval_request" })
        .success,
    ).toBe(false);
    expect(EVENT_PAYLOAD_SCHEMAS["ticket.sla_breached"].safeParse(breach).success).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS["ticket.sla_breached"].safeParse({
        ...breach,
        deliveryTicketStageId: undefined,
      }).success,
    ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["ticket.sla_breached"].safeParse({ ...breach, dueAt: "tomorrow" })
        .success,
    ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["ticket.sla_breached"].safeParse({ ...breach, extra: true }).success,
    ).toBe(false);
  });
});

describe("M5环节时钟、暂停集合与真实校验", { timeout: 60_000 }, () => {
  it.each(["withdrawn", "self_heal"] as const)(
    "plan_confirm 等待员工时真实取消暂停经 %s 释放，三个时限与当前visit计时器一致",
    async (releaseEvent) => {
      const o = await h.order(true),
        id = o.deliveryTicketIds[0]!,
        cause = await cancellationCause(h, o);
      const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
        where: { deliveryTicketId: id, completedAt: null },
      });
      expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({
        step: "plan_confirm",
        waitingOn: "staff",
        stepDueAt: stage.dueAt,
      });
      expect(stage.dueAt).not.toBeNull();
      expect(
        await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }),
      ).toMatchObject({ staffDueAt: stage.dueAt });
      await h.tx.run(async (tx) =>
        holdCancelReviewPauses(
          tx,
          h.deps,
          cause.ctx,
          await readCancelReviewHoldTargets(tx, h.assembly, cause.approvalId),
        ),
      );
      const paused = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } });
      expect(paused).toMatchObject({ pauseCount: 1, pauseRemainingMin: expect.any(Number) });
      expect(
        await h.prisma.timer.count({ where: { subjectId: stage.id, status: "scheduled" } }),
      ).toBe(0);
      h.clock.advance(60 * 60_000);
      const expected = await h.tx.run(async (tx) =>
        h.deps.sla.dueAt(tx, {
          policy: "ticket.plan_confirm",
          amount: paused.pauseRemainingMin!,
          unit: "work_minutes",
          from: h.clock.now(),
          workHours: await workHoursAt(tx, h.clock.now()),
        }),
      );
      await h.prisma.cancelRequest.update({
        where: { id: cause.id },
        data: { status: "not_executed", closedAt: h.clock.now(), closeReason: "withdrawn" },
      });
      if (releaseEvent === "withdrawn")
        await h.tx.run(async (tx) =>
          releaseCancelReviewPauses(tx, h.deps, cause.ctx, {
            targets: await readCancelReviewPauseTargets(tx, [cause.approvalId]),
            releaseEvent,
          }),
        );
      else {
        const violations = await h.tx.run((tx) => findDeliveryViolations(tx, "I2"));
        expect(violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ subject: { type: "delivery_ticket", id } }),
          ]),
        );
      }
      expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({
        step: "plan_confirm",
        waitingOn: "staff",
        pauseCount: 0,
        pausedAt: null,
        pauseRemainingMin: null,
        stepDueAt: expected.dueAt,
      });
      expect(
        await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: stage.id } }),
      ).toMatchObject({
        dueAt: expected.dueAt,
        completedAt: null,
        visitNo: stage.visitNo,
        enteredAt: stage.enteredAt,
        pausedMinutes: 60,
      });
      expect(
        await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }),
      ).toMatchObject({ staffDueAt: expected.dueAt });
      expect(
        await h.prisma.deliveryTicketPause.findFirstOrThrow({
          where: { deliveryTicketId: id, refId: cause.approvalId },
        }),
      ).toMatchObject({ releasedAt: h.clock.now(), releaseEvent });
      expect(
        await h.prisma.timer.findMany({ where: { subjectId: stage.id, status: "scheduled" } }),
      ).toEqual([expect.objectContaining({ kind: "sla.breach", fireAt: expected.dueAt })]);
    },
  );

  it("两种有效取消来源叠加，仅最后一个解除才恢复剩余工作分钟且暂停拒绝强迁", async () => {
    const f = await prepared(h),
      first = await cancellationCause(h, f.o),
      second = await cancellationCause(h, f.o, true);
    const before = await h.prisma.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: f.id, completedAt: null },
    });
    const timers = await h.prisma.timer.findMany({
      where: { subjectId: before.id, status: "scheduled" },
    });
    for (const cause of [first, second])
      await h.tx.run(async (tx) => {
        const targets = await readCancelReviewHoldTargets(tx, h.assembly, cause.approvalId);
        await holdCancelReviewPauses(tx, h.deps, cause.ctx, targets);
      });
    const paused = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } });
    expect(paused).toMatchObject({
      pauseCount: 2,
      pausedAt: h.clock.now(),
      pauseRemainingMin: expect.any(Number),
    });
    expect(
      await h.prisma.timer.count({
        where: { id: { in: timers.map((t) => t.id) }, status: "cancelled" },
      }),
    ).toBe(timers.length);
    const history = await h.prisma.statusTransition.count({ where: { subjectId: f.id } });
    await expect(
      m5Service(h).forceTransition(f.qc.ctx, { ...f.qc.staff, stepUpAt: h.clock.now() }, f.id, {
        toStep: "plan_confirm",
        note: "暂停期间不允许强制回退环节",
        confirm: { ticketNo: paused.ticketNo, fromStep: "sample_making" },
      }),
    ).rejects.toMatchObject({ error: "TICKET_ON_HOLD" });
    expect(await h.prisma.statusTransition.count({ where: { subjectId: f.id } })).toBe(history);
    expect(
      (await h.tx.run((tx) => findDeliveryViolations(tx, "I2"))).filter(
        (v) => v.subject && "id" in v.subject && v.subject.id === f.id,
      ),
    ).toEqual([]);
    h.clock.advance(30 * 60_000);
    await h.prisma.cancelRequest.update({
      where: { id: first.id },
      data: { status: "not_executed", closedAt: h.clock.now(), closeReason: "withdrawn" },
    });
    await h.tx.run(async (tx) =>
      releaseCancelReviewPauses(tx, h.deps, first.ctx, {
        targets: await readCancelReviewPauseTargets(tx, [first.approvalId]),
        releaseEvent: "withdrawn",
      }),
    );
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      pauseCount: 1,
      pausedAt: paused.pausedAt,
      pauseRemainingMin: paused.pauseRemainingMin,
      stepDueAt: paused.stepDueAt,
    });
    expect(
      await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: before.id } }),
    ).toEqual(before);
    expect(
      (await h.tx.run((tx) => findDeliveryViolations(tx, "I2"))).filter(
        (v) => v.subject && "id" in v.subject && v.subject.id === f.id,
      ),
    ).toEqual([]);
    h.clock.advance(30 * 60_000);
    const expected = await h.tx.run(async (tx) =>
      h.deps.sla.dueAt(tx, {
        policy: "ticket.sample_making",
        amount: paused.pauseRemainingMin!,
        unit: "work_minutes",
        from: h.clock.now(),
        workHours: await workHoursAt(tx, h.clock.now()),
      }),
    );
    await h.prisma.cancelRequest.update({
      where: { id: second.id },
      data: { status: "not_executed", closedAt: h.clock.now(), closeReason: "withdrawn" },
    });
    await h.tx.run(async (tx) =>
      releaseCancelReviewPauses(tx, h.deps, second.ctx, {
        targets: await readCancelReviewPauseTargets(tx, [second.approvalId]),
        releaseEvent: "withdrawn",
      }),
    );
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      pauseCount: 0,
      pausedAt: null,
      pauseRemainingMin: null,
      stepDueAt: expected.dueAt,
    });
    expect(
      await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: before.id } }),
    ).toMatchObject({
      dueAt: expected.dueAt,
      pausedMinutes: 60,
      enteredAt: before.enteredAt,
      visitNo: before.visitNo,
    });
    expect(
      await h.prisma.timer.findMany({ where: { subjectId: before.id, status: "scheduled" } }),
    ).toEqual([expect.objectContaining({ kind: "sla.breach", fireAt: expected.dueAt })]);
    expect(
      (await h.tx.run((tx) => findDeliveryViolations(tx, "I2"))).filter(
        (v) => v.subject && "id" in v.subject && v.subject.id === f.id,
      ),
    ).toEqual([]);
  });

  it("真实日历导入经登记subscriber重算当前visit，旧dispatch失效且重复导入无业务副作用", async () => {
    const o = await h.order(),
      id = o.deliveryTicketIds[0]!,
      actor = await h.staff();
    const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: id, completedAt: null },
    });
    expect(stage.dueAt).not.toBeNull();
    const oldTimer = await h.prisma.timer.findFirstOrThrow({
      where: { subjectId: stage.id, status: "scheduled" },
    });
    await h.prisma.timer.update({
      where: { id: oldTimer.id },
      data: {
        status: "dispatched",
        dispatchNo: 1,
        leaseUntil: new Date(h.clock.now().getTime() + 60_000),
      },
    });
    const calendar = createCalendarAdmin({ tx: h.tx, clock: h.clock, events: h.events });
    const original = await h.prisma.workCalendarDay.findMany({
      where: { day: { gte: new Date("2026-01-01"), lt: new Date("2027-01-01") } },
      orderBy: { day: "asc" },
    });
    const exceptions = original
      .filter((d) => d.kind === "holiday" || d.kind === "adjusted_workday")
      .map((d) => ({
        date: d.day.toISOString().slice(0, 10),
        kind: d.kind as "holiday" | "adjusted_workday",
        note: d.note ?? "原测试日历",
      }));
    const holiday = calendarDate(stage.dueAt!);
    try {
      const imported = await calendar.import(
        { identity: actor.ctx, staff: actor.staff },
        {
          year: 2026,
          source: "W5-03虚构放假变更",
          days: [
            ...exceptions.filter((d) => d.date !== holiday),
            { date: holiday, kind: "holiday", note: "测试新增放假" },
          ],
        },
      );
      expect(imported.isChanged).toBe(true);
      const row = await h.prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: "calendar.imported",
          payload: { path: ["calendarVersion"], equals: imported.calendarVersion },
        },
      });
      const event = {
        id: row.id,
        type: row.eventType,
        payload: row.payload as Record<string, unknown>,
      };
      const subscriber = h.assembly.subscriber("delivery.onCalendarImported")!;
      await h.tx.run((tx) => subscriber.handle(tx, event));
      const changed = await h.prisma.deliveryTicketStage.findUniqueOrThrow({
        where: { id: stage.id },
      });
      expect(changed).toMatchObject({
        completedAt: null,
        enteredAt: stage.enteredAt,
        visitNo: stage.visitNo,
        slaSnapshot: { calendarVersion: imported.calendarVersion },
      });
      expect(changed.dueAt!.getTime()).toBeGreaterThan(stage.dueAt!.getTime());
      expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({
        stepDueAt: changed.dueAt,
      });
      expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: oldTimer.id } })).toMatchObject({
        status: "cancelled",
      });
      expect(
        await h.prisma.timer.findMany({ where: { subjectId: stage.id, status: "scheduled" } }),
      ).toEqual([
        expect.objectContaining({
          fireAt: changed.dueAt,
          payload: { ...(changed.slaSnapshot as object), dueAt: changed.dueAt!.toISOString() },
        }),
      ]);
      const timers = createTimers({ assembly: h.assembly });
      expect(
        await runTimer(
          {
            tx: h.tx,
            assembly: h.assembly,
            registry: timers.registry,
            clock: h.clock,
            alerts: alertsOf(h.assembly),
          },
          { timerId: oldTimer.id, dispatchNo: 1, kind: "sla.breach" },
        ),
      ).toBe("stale");
      const counts = await h.tx.run((tx) => h.counts(tx, id));
      await h.tx.run((tx) => subscriber.handle(tx, event));
      expect(await h.tx.run((tx) => h.counts(tx, id))).toEqual(counts);
      expect(
        await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: stage.id } }),
      ).toEqual(changed);
      expect(await h.tx.run((tx) => findDeliveryViolations(tx, "I5"))).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ subject: { type: "delivery_ticket", id } }),
        ]),
      );
    } finally {
      await calendar.import(
        { identity: actor.ctx, staff: actor.staff },
        { year: 2026, source: "恢复原测试日历", days: exceptions },
      );
    }
  });

  it("I2真实发现失效原因及计数不一致，自愈释放并恢复时钟，第二次无新增", async () => {
    const f = await prepared(h),
      now = h.clock.now();
    const pause = await h.prisma.deliveryTicketPause.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: f.id,
        reason: "plan_amendment",
        refType: "delivery_plan_version",
        refId: uuidv7(),
        actorType: "system",
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.deliveryTicket.update({
      where: { id: f.id },
      data: { pauseCount: 2, pausedAt: now, pauseRemainingMin: 30 },
    });
    const check = h.assembly.invariant("delivery.I2");
    expect(check).toMatchObject({ heal: "heal_and_alert" });
    const violations = await h.tx.run((tx) => check!.run!(tx, {}, { now }));
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "delivery_ticket", id: f.id },
          entityId: f.o.entity.id,
        }),
      ]),
    );
    expect(
      await h.prisma.deliveryTicketPause.findUniqueOrThrow({ where: { id: pause.id } }),
    ).toMatchObject({ releasedAt: now, releaseEvent: "self_heal" });
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      pauseCount: 0,
      pausedAt: null,
      pauseRemainingMin: null,
    });
    const before = await h.tx.run((tx) => h.counts(tx, f.id));
    expect(await h.tx.run((tx) => check!.run!(tx, {}, { now }))).toEqual([]);
    expect(await h.tx.run((tx) => h.counts(tx, f.id))).toEqual(before);
  });
});
