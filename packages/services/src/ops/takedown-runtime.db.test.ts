import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, atMinuteOfDay, calendarDate, dayRange } from "@liyoxi/shared/time";
import { alertsOf } from "../kernel/index.js";
import { consumeDelivery, createEvents } from "../events/index.js";
import { createTimers, runTimer } from "../timers/index.js";
import { createCalendarAdmin } from "../sla/index.js";
import { createPublishPatrol } from "../publish/index.js";
import {
  createTakedownFixture,
  claimTakedownTimer,
  claimTakedownCalendar,
  useSeededDatabase,
} from "../testing/index.js";
import { createPatrolAssembly } from "./patrol-runtime.js";
import { createTakedownAssembly } from "./takedown-runtime.js";

const db = useSeededDatabase("services", { max: 2 });
beforeAll(async () => {
  await db.prisma();
});
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const h = createTakedownFixture(await db.prisma());
  closes.push(() => h.close());
  const build = () => {
    const patrol = createPatrolAssembly(h.assembly);
    patrol.attach(createPublishPatrol(h.takedownDeps));
    const takedown = createTakedownAssembly(patrol.assembly);
    takedown.attach(h.takedown);
    closes.push(
      () => patrol.close(),
      () => takedown.close(),
    );
    return { patrol, takedown, assembly: takedown.assembly };
  };
  return { h, build };
}
async function preparedTimerFixture() {
  const scope = await fixture();
  const f = await scope.h.ready({ twoAccounts: true, daysBeforeEnd: 31 });
  return { ...scope, f };
}
describe("timer运行时实例", () => {
  let prepared!: Awaited<ReturnType<typeof preparedTimerFixture>>;
  beforeEach(async () => {
    prepared = await preparedTimerFixture();
  });
  it("真实两timer与日历订阅按实例绑定，关闭不借另一实例，I7保留巡检后下架贡献", async () => {
    const { h, build, f } = prepared,
      first = build(),
      second = build();
    const timers = createTimers({ assembly: second.assembly }),
      end = f.item.usageEndDate.toISOString().slice(0, 10);
    for (const kind of ["takedown.create", "takedown.overdue"])
      expect(second.assembly.timerHandlers.filter((t) => t.kind === kind)).toHaveLength(1);
    expect(
      second.assembly.subscribers.filter((s) => s.name === "publish.onCalendarImported"),
    ).toHaveLength(1);
    const due = await h.prisma.timer.findFirstOrThrow({
      where: { kind: "takedown.create", subjectId: f.item.id, status: "scheduled" },
    });
    h.clock.set(dayRange(addDays(end, -30)).start);
    const ref = await claimTakedownTimer(h.tx, {
      timerId: due.id,
      subjectId: f.item.id,
      now: h.clock.now(),
    });
    await first.takedown.close();
    const input = { ...due, payload: due.payload as Record<string, unknown> };
    await expect(
      h.tx.run((tx) => first.assembly.timerHandler("takedown.create")!.handle(tx, input)),
    ).rejects.toThrow("未绑定或已关闭");
    await expect(
      h.tx.run((tx) => first.assembly.invariant("timers.I7")!.run!(tx, {}, { now: h.clock.now() })),
    ).rejects.toThrow("未绑定或已关闭");
    const runDeps = {
      tx: h.tx,
      clock: h.clock,
      assembly: second.assembly,
      registry: timers.registry,
      alerts: alertsOf(second.assembly),
    };
    expect(await runTimer(runDeps, ref)).toBe("fired");
    expect(await runTimer(runDeps, ref)).toBe("stale");
    const rows = await h.prisma.takedownTask.findMany({ where: { deliveryTicketId: f.id } });
    expect(rows).toHaveLength(2);
    await h.tx.run((tx) =>
      timers.cancel(tx, {
        subject: { type: "takedown_task", id: rows[0]!.id },
        kinds: ["takedown.overdue"],
      }),
    );
    expect(
      await h.tx.run((tx) =>
        second.assembly.invariant("timers.I7")!.run!(tx, {}, { now: h.clock.now() }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "takedown_task", id: rows[0]!.id },
          healed: expect.any(Object),
        }),
      ]),
    );
    await second.patrol.close();
    // A live takedown wrapper still calls its original patrol contribution first.
    await expect(
      h.tx.run((tx) =>
        second.assembly.invariant("timers.I7")!.run!(tx, {}, { now: h.clock.now() }),
      ),
    ).rejects.toThrow("巡检运行时未绑定或已关闭");
    const overdue = await h.prisma.timer.findFirstOrThrow({
      where: { kind: "takedown.overdue", subjectId: rows[0]!.id, status: "scheduled" },
    });
    h.clock.set(atMinuteOfDay(addDays(end, 1), 540));
    const overdueRef = await claimTakedownTimer(h.tx, {
      timerId: overdue.id,
      subjectId: rows[0]!.id,
      now: h.clock.now(),
    });
    expect(await runTimer(runDeps, overdueRef)).toBe("fired");
    expect(
      await h.prisma.followUp.count({ where: { subjectId: rows[0]!.id, actorType: "system" } }),
    ).toBe(0);
    const draining = createTakedownAssembly(h.assembly);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    draining.attach({
      ...h.takedown,
      create: async (...args) => {
        entered();
        await gate;
        return h.takedown.create(...args);
      },
    });
    const inFlight = h.tx.run((tx) =>
      draining.assembly.timerHandler("takedown.create")!.handle(tx, input),
    );
    await admitted;
    let closed = false;
    const closing = draining.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(
      h.tx.run((tx) => draining.assembly.timerHandler("takedown.create")!.handle(tx, input)),
    ).rejects.toThrow("已关闭");
    release();
    expect(await inFlight).toBe("skipped");
    await closing;
    expect(closed).toBe(true);
  });
});
it("真实日历导入消费重算核查截止与同态历史，重复/乱序不回退且不改止日", async () => {
  const { h, build } = await fixture(),
    f = await h.ready({ twoAccounts: true }),
    runtime = build();
  const id = f.takedowns[0]!.id;
  await h.takedown.confirm(f.o.viewer, id, { method: "not_published" });
  const before = await h.prisma.takedownTask.findUniqueOrThrow({ where: { id } });
  const year = Number(calendarDate(before.checkDueAt!).slice(0, 4)),
    changed = calendarDate(before.checkDueAt!);
  const events = createEvents({ assembly: runtime.assembly, tx: h.tx, clock: h.clock });
  const admin = createCalendarAdmin({ tx: h.tx, clock: h.clock, events });
  async function imported(days: Array<{ date: string; kind: "holiday"; note: string }>) {
    await admin.import(
      { identity: f.qc.ctx, staff: f.qc.staff },
      { year, source: "隔离测试工作日历更正", days },
    );
    return h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "calendar.imported" },
      orderBy: { seq: "desc" },
    });
  }
  const old = await imported([{ date: changed, kind: "holiday", note: "核查日放假" }]);
  const newer = await imported([
    { date: changed, kind: "holiday", note: "核查日放假" },
    { date: addDays(changed, 2), kind: "holiday", note: "后续假日" },
  ]);
  await events.expand();
  const claimed = await Promise.all(
    [old.id, newer.id].map((id) => claimTakedownCalendar(h.tx, id)),
  );
  const consume = async (id: string) => {
    const ref = claimed.find(
      (r) => r.eventId === id && r.subscriber === "publish.onCalendarImported",
    );
    expect(ref).toBeDefined();
    return consumeDelivery(
      { tx: h.tx, subscribers: events.subscribers, alerts: alertsOf(runtime.assembly) },
      ref!,
    );
  };
  expect(await consume(old.id)).toBe("done");
  expect((await h.prisma.takedownTask.findUniqueOrThrow({ where: { id } })).checkDueAt).toEqual(
    before.checkDueAt,
  );
  expect(await consume(newer.id)).toBe("done");
  expect(await consume(newer.id)).toBe("stale");
  const after = await h.prisma.takedownTask.findUniqueOrThrow({ where: { id } });
  expect(after.checkDueAt!.getTime()).toBeGreaterThan(before.checkDueAt!.getTime());
  expect(after.usageEndDate).toEqual(before.usageEndDate);
  expect(after.dueDate).toEqual(before.dueDate);
  expect(
    (await h.prisma.orderItem.findUniqueOrThrow({ where: { id: f.item.id } })).usageEndDate,
  ).toEqual(f.item.usageEndDate);
  const history = await h.prisma.statusTransition.findMany({
    where: { subjectId: id, event: "sla.recalculated" },
  });
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    fromState: "merchant_confirmed",
    toState: "merchant_confirmed",
    payload: {
      dueAtBefore: before.checkDueAt!.toISOString(),
      dueAtAfter: after.checkDueAt!.toISOString(),
    },
  });
});
