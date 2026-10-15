import { expect, it } from "vitest";
import { alertsOf, uuidv7 } from "../kernel/index.js";
import { consumeDelivery, dispatchDue } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";
import { createTimers, runTimer, scanDue, timerKey } from "../timers/index.js";
import {
  assembleForTest,
  createRecordingPorts,
  createSampleEvents,
  createWorkerSample,
  SAMPLE_TIMER_CATALOG,
  SAMPLE_TIMER_KINDS,
  SAMPLE_TIMER_SUBJECT,
  sampleSystemContext,
  useTestDatabase,
  WORKER_SAMPLE_SUBSCRIBERS,
} from "../testing/index.js";

const db = useTestDatabase("services");
it("W227服务端：queued/Redis降级inline失败先真实提交，旁路同步抛错和拒绝不改变结果", async () => {
  const prisma = await db.prisma(),
    workers = createWorkerSample(),
    ports = createRecordingPorts();
  const sample = createSampleEvents(prisma, {
    registrations: [workers.registration, ports.registration],
  });
  const { plain, critical } = WORKER_SAMPLE_SUBSCRIBERS;
  workers.control.failing.add(plain);
  workers.control.failing.add(critical);
  const dramaOrderId = uuidv7();
  const emitted = await sample.tx.run((tx) =>
    sample.events.emit(tx, sampleSystemContext(), {
      type: "lyxtest.order.placed",
      aggregate: { type: "drama_order", id: dramaOrderId },
      payload: { v: 1, dramaOrderId },
    }),
  );
  if (emitted.id === null) throw new Error("fixture event was not emitted");
  const eventId = emitted.id;
  while ((await sample.events.expand()).events > 0);
  // 夹具只有既往次数；retry/dead/failed终态必须由本次正式执行写入。
  await prisma.$executeRawUnsafe(
    "UPDATE outbox_delivery SET attempts=9 WHERE outbox_event_id=$1::uuid AND subscriber=$2::text",
    eventId,
    plain,
  );
  const queued: DeliveryRef[] = [],
    deliverySeen: string[] = [],
    pending: Promise<unknown>[] = [];
  const delivery = {
    tx: sample.tx,
    subscribers: sample.events.subscribers,
    alerts: alertsOf(sample.assembly),
    channel: {
      downForMs: () => 0,
      async enqueue(_queue: string, _id: string, data: Readonly<Record<string, unknown>>) {
        if (data.subscriber === critical) throw new Error("fixture Redis unavailable");
        queued.push({
          eventId: String(data.eventId),
          subscriber: String(data.subscriber),
          dispatchNo: Number(data.dispatchNo),
        });
      },
    },
    onFailure(outcome: "retry" | "dead") {
      const checked = (async () => {
        const rows = await prisma.outboxDelivery.findMany({
          where: { outboxEventId: eventId, status: outcome },
        });
        expect(rows).toHaveLength(1);
        deliverySeen.push(outcome);
        throw new Error("observer rejection");
      })();
      pending.push(checked);
      return checked;
    },
  };
  expect(await dispatchDue(delivery)).toMatchObject({ enqueued: 1, inProcess: 1 });
  expect(deliverySeen).not.toContain("dead");
  expect(queued).toHaveLength(1);
  expect(await consumeDelivery(delivery, queued[0]!)).toBe("dead");
  expect(await consumeDelivery(delivery, queued[0]!)).toBe("stale");
  const deliveryResults = await Promise.allSettled(pending);
  expect(deliverySeen.sort()).toEqual(["dead", "retry"]);
  expect(
    deliveryResults.every(
      (one) => one.status === "rejected" && one.reason.message === "observer rejection",
    ),
  ).toBe(true);
  expect(
    await prisma.outboxDelivery.findMany({
      where: { outboxEventId: eventId },
      select: { subscriber: true, status: true, attempts: true },
      orderBy: { subscriber: "asc" },
    }),
  ).toEqual([
    { subscriber: critical, status: "retry", attempts: 1 },
    { subscriber: plain, status: "dead", attempts: 10 },
  ]);

  const assembly = assembleForTest({
    entry: "worker",
    extra: [workers.registration, ports.registration],
    omitReal: ["recurringJobs"],
  });
  const timers = createTimers({ assembly, catalog: SAMPLE_TIMER_CATALOG }),
    kind = SAMPLE_TIMER_KINDS.plain;
  workers.control.failing.add(kind);
  const ids: string[] = [],
    timerSeen: string[] = [];
  let down = false,
    synchronouslyThrows = false;
  const timing = {
    tx: sample.tx,
    assembly,
    registry: timers.registry,
    clock: sample.clock,
    alerts: alertsOf(assembly),
    channel: {
      downForMs: () => (down ? 60_000 : 0),
      async enqueue() {
        if (down) throw new Error("fixture Redis unavailable");
      },
    },
    onFailure(outcome: "retry" | "failed") {
      timerSeen.push(outcome);
      if (synchronouslyThrows) throw new Error("observer throw");
      const checked = (async () => {
        expect(
          await prisma.timer.count({
            where: { id: { in: ids }, status: outcome === "retry" ? "scheduled" : "failed" },
          }),
        ).toBe(1);
        throw new Error("observer rejection");
      })();
      pending.push(checked);
      return checked;
    },
  };
  const arm = async () => {
    const subject = { type: SAMPLE_TIMER_SUBJECT, id: uuidv7() };
    const row = await sample.tx.run((tx) =>
      timers.arm(tx, { kind, subject, key: timerKey(kind, subject), fireAt: sample.clock.now() }),
    );
    ids.push(row.id);
    return row.id;
  };
  const first = await arm();
  await prisma.$executeRawUnsafe("UPDATE timer SET attempts=5 WHERE id=$1::uuid", first);
  expect(await scanDue(timing, { limit: 1 })).toMatchObject({ enqueued: 1, inProcess: 0 });
  const row = await prisma.timer.findUniqueOrThrow({ where: { id: first } });
  expect(await runTimer(timing, { timerId: first, kind, dispatchNo: row.dispatchNo })).toBe(
    "failed",
  );
  const allResults = await Promise.allSettled(pending);
  expect(
    allResults.every(
      (one) => one.status === "rejected" && one.reason.message === "observer rejection",
    ),
  ).toBe(true);
  down = true;
  synchronouslyThrows = true;
  const second = await arm(),
    scanned = await scanDue(timing, { limit: 1 });
  await scanned.background;
  expect(scanned.inProcess).toBe(1);
  expect(timerSeen).toEqual(["failed", "retry"]);
  expect(
    await prisma.timer.findUniqueOrThrow({
      where: { id: second },
      select: { status: true, attempts: true, firedAt: true },
    }),
  ).toEqual({ status: "scheduled", attempts: 1, firedAt: null });
}, 60_000);
