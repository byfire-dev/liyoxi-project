import { beforeAll, afterAll, it, expect } from "vitest";
import { z } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { buildWorkerServices, createContentLicense, createFlow, uuidv7 } from "@liyoxi/services";
import type { TimerRef, TxRunner } from "@liyoxi/services";
import {
  useSeededDatabase,
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  createSampleEvents,
  fakeKeyEnv,
} from "@liyoxi/services/testing";
const db = useSeededDatabase("worker"),
  clock = createClock(),
  queued: TimerRef[] = [];
let worker: ReturnType<typeof buildWorkerServices>,
  prisma: Awaited<ReturnType<typeof db.prisma>>,
  tx: TxRunner,
  license: ReturnType<typeof createContentLicense>,
  make: ReturnType<typeof createFactories>;
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createSampleEvents(prisma, { registrations: [] }).tx;
  make = createFactories({ db: prisma, clock });
  worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock }),
    keys: fakeKeyEnv(),
    channel: {
      downForMs: () => 0,
      enqueue: async (channel, _key, ref) => {
        if (channel === "timer_run")
          queued.push(
            z
              .strictObject({
                timerId: z.uuid(),
                dispatchNo: z.int().nonnegative(),
                kind: z.string(),
              })
              .parse(ref),
          );
      },
    },
  });
  const flow = createFlow({ clock, assembly: worker.assembly, events: worker.events });
  license = createContentLicense({ clock, flow, timers: worker.timers });
}, 180000);
afterAll(async () => {
  await worker?.shutdownMediaJobs?.();
  await worker?.closeNotify();
  await worker?.closeAnalytics?.();
  await worker?.closeStaff?.();
  worker?.closeMediaJobs?.();
  worker?.closeWebhooks?.();
  worker?.closeOrder?.();
  worker?.closeBillingTimers?.();
  worker?.closeDelivery?.();
  worker?.closePublish?.();
  await Promise.all([worker?.closeMediaDrivers?.(), worker?.closeStorageDrivers?.()]);
});
async function drama(end: string) {
  const row = await make.drama({ status: "listed", heatTier: "A" });
  await prisma.dramaCopyright.create({
    data: {
      dramaId: row.id,
      licenseEndDate: new Date(`${end}T00:00:00Z`),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  return row;
}
it("content.license_end 真worker认领执行，次日上海00:00/重复不重迁移", async () => {
  clock.set(new Date("2026-01-05T04:00:00Z"));
  const d = await drama("2026-01-06");
  await tx.run((t) => license.rearm(t, d.id));
  const timer = await prisma.timer.findFirstOrThrow({ where: { subjectId: d.id } });
  expect(timer.fireAt.toISOString()).toBe("2026-01-06T16:00:00.000Z");
  clock.set(new Date("2026-01-06T15:59:59.999Z"));
  queued.length = 0;
  await worker.scan();
  expect(queued.some((ref) => ref.timerId === timer.id)).toBe(false);
  clock.advance(1);
  await worker.scan();
  const ref = queued.find((ref) => ref.timerId === timer.id)!;
  expect(ref).toBeDefined();
  expect(await worker.runTimer(ref)).toBe("fired");
  expect(await worker.runTimer(ref)).toBe("stale");
  expect(await prisma.drama.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
    status: "delisted",
    delistReasonCode: "license_expired",
    delistNote: null,
  });
  expect(
    await prisma.statusTransition.count({
      where: { subjectId: d.id, event: "drama.license_expire" },
    }),
  ).toBe(1);
});
it("真实I3重排取消旧版权timer，迟到旧callback不下架续期剧", async () => {
  clock.set(new Date("2026-01-05T04:00:00Z"));
  const d = await drama("2026-01-07");
  await tx.run((t) => license.rearm(t, d.id));
  const old = await prisma.timer.findFirstOrThrow({ where: { subjectId: d.id } });
  await prisma.dramaCopyright.update({
    where: { dramaId: d.id },
    data: { licenseEndDate: new Date("2026-02-07T00:00:00Z") },
  });
  await tx.run((t) => worker.assembly.invariant("content.I3")!.run!(t, {}, { now: clock.now() }));
  expect((await prisma.timer.findUniqueOrThrow({ where: { id: old.id } })).status).toBe(
    "cancelled",
  );
  clock.set(new Date("2026-01-08T00:00:00Z"));
  expect(
    await tx.run((t) =>
      worker.assembly.timerHandler("content.license_end")!.handle(t, {
        ...old,
        payload: z.record(z.string(), z.unknown()).nullable().parse(old.payload),
      }),
    ),
  ).toBe("skipped");
  expect((await prisma.drama.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("listed");
});
it("pricing.drama_price_effective 真worker延迟timer只发一次事件，取消的修订不发", async () => {
  clock.set(new Date("2026-01-05T04:00:00Z"));
  const d = await make.drama({ status: "draft", heatTier: "A" }),
    employee = await make.staff({ staffRoleKey: "super_admin" }),
    id = uuidv7(),
    at = new Date("2026-01-06T16:00:00Z");
  await prisma.dramaPriceRevision.create({
    data: {
      id,
      dramaId: d.id,
      mode: "custom",
      customPoints: 1700,
      prevPoints: 2000,
      newPoints: 1700,
      effectiveAt: at,
      reasonCode: "quality",
      createdByStaffId: employee.id,
      createdAt: clock.now(),
    },
  });
  await tx.run((t) =>
    worker.timers.arm(t, {
      kind: "pricing.drama_price_effective",
      subject: { type: "drama_price_revision", id },
      key: `pricing.drama_price_effective:drama_price_revision:${id}`,
      fireAt: at,
    }),
  );
  clock.set(new Date("2026-01-07T02:00:00Z"));
  queued.length = 0;
  await worker.scan();
  const ref = queued.find((ref) => ref.kind === "pricing.drama_price_effective")!;
  expect(ref).toBeDefined();
  expect(await worker.runTimer(ref)).toBe("fired");
  expect(await worker.runTimer(ref)).toBe("stale");
  expect(
    await prisma.outboxEvent.count({
      where: { aggregateId: id, eventType: "pricing.drama_price_changed" },
    }),
  ).toBe(1);
});
it("真实notify.remind_scan 消费当前版权查询与当前drama edit员工，R7按日幂等不另建timer", async () => {
  clock.set(new Date("2026-10-08T01:04:59.999Z"));
  const date = addDays(calendarDate(clock.now()), 90),
    d = await drama(date),
    employee = await make.staff({ staffRoleKey: "content_ops" });
  await worker.assembly.recurringJob("notify.remind_scan")!.run({ scheduledFor: clock.now() });
  expect(
    await prisma.notification.count({ where: { sourceRule: "R7", staffId: employee.id } }),
  ).toBe(0);
  clock.advance(1);
  await worker.assembly.recurringJob("notify.remind_scan")!.run({ scheduledFor: clock.now() });
  await worker.assembly.recurringJob("notify.remind_scan")!.run({ scheduledFor: clock.now() });
  expect(
    await prisma.notification.count({
      where: {
        sourceRule: "R7",
        staffId: employee.id,
        dedupeKey: `copyright:${employee.id}:2026-10-08`,
      },
    }),
  ).toBe(1);
  expect(await prisma.timer.count({ where: { subjectId: d.id } })).toBe(0);
  expect(
    await prisma.notificationDelivery.count({
      where: {
        notification: { staffId: employee.id, sourceRule: "R7" },
        status: "sent",
        channel: "wecom",
      },
    }),
  ).toBe(0);
});
