import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { alertsOf, lockRows, uuidv7 } from "../kernel/index.js";
import { createTimers, runTimer, timerKey } from "../timers/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { handleDeliveryStageSlaBreach } from "./index.js";
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
