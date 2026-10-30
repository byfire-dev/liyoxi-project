import { afterAll, beforeAll, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { claimDeliveries, consumeDelivery, createEvents } from "../events/index.js";
import { createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import { createCalendarAdmin, workHoursAt } from "../sla/index.js";
import {
  assertSnapshotsEqual,
  createProductionActionsTools,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { startHarness } from "./__fixtures__/start-harness.js";
import type { StartHarness } from "./__fixtures__/start-harness.js";

const handle = useSeededDatabase("services", { max: 1 });
let h: StartHarness;
let production: Awaited<ReturnType<typeof createProductionActionsTools>>;
beforeAll(async () => {
  const prisma = await handle.prisma();
  h = startHarness(prisma);
  production = await createProductionActionsTools(prisma, "ad", { durationMs: 3000 });
  h.clock.set(production.clock.now());
}, 120_000);
afterAll(async () => {
  await production?.close();
  h?.clear();
});

it("首版历史已超时但当前修改轮次未超时：真实日历投递仍重臂当前轮次，重复不新增", async () => {
  h.clock.advance(2 * 86_400_000);
  const ad = production.ad!,
    now = h.clock.now(),
    firstBreachedAt = new Date(ad.firstDueAt.getTime() + 60_000),
    info = await h.prisma.mediaInfo.findUniqueOrThrow({
      where: { fileId: production.source.fileId },
    }),
    facts = await production.tx.run((tx) =>
      production.media.adProductionFacts(tx, production.source.fileId),
    );
  // The public W5-04 harness only seeds pending/uploading inputs. Its ledger, complete,
  // promote and probe produce every captured/stored/checked fact used by this history.
  expect(facts.ready).toBe(true);
  expect(production.source.pipelineState).toBe("ready");
  expect(
    await h.prisma.fileObject.findUniqueOrThrow({ where: { id: production.source.fileId } }),
  ).toMatchObject({ status: "stored" });
  expect(
    await h.prisma.pointHold.findUniqueOrThrow({ where: { id: ad.pointHoldId } }),
  ).toMatchObject({ status: "captured", capturedAt: expect.any(Date) });
  const due = await h.tx.run(async (tx) =>
    h.deps.sla.dueAt(tx, {
      policy: "ad.revision",
      amount: 2,
      unit: "work_days",
      from: now,
      workHours: await workHoursAt(tx, now),
    }),
  );
  // W5-08's revision producer is absent. These are explicit nonterminal historical
  // business inputs; no confirmation, storage/QC pass or money success is invented.
  await h.prisma.adVersion.create({
    data: {
      id: uuidv7(),
      adId: ad.id,
      entityId: ad.entityId,
      storeId: ad.storeId,
      versionNo: 1,
      fileId: production.source.fileId,
      durationMs: info.durationMs!,
      width: info.displayWidth!,
      height: info.displayHeight!,
      uploadedByStaffId: production.actor.staff!.staff.id,
      uploadedAt: now,
      pushedAt: now,
      previewChannels: ["weapp"],
      decision: "revision_requested",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const revision = await h.prisma.adRevision.create({
    data: {
      id: uuidv7(),
      adId: ad.id,
      entityId: ad.entityId,
      storeId: ad.storeId,
      revisionNo: 1,
      onVersionNo: 1,
      source: "staff_on_behalf",
      note: "初始历史修改意见，仅测试当前轮次日历时限",
      actorType: "staff",
      actorId: production.actor.staff!.staff.id,
      client: "admin",
      dueAt: due.dueAt,
      breachedAt: null,
      fulfilledByVersionNo: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.ad.update({
    where: { id: ad.id },
    data: {
      status: "revising",
      latestVersionNo: 1,
      revisionCount: 1,
      firstBreachedAt,
      dueAt: due.dueAt,
      slaSnapshot: { ...due.snapshot },
      updatedAt: now,
    },
  });
  const key = `sla.breach:ad:${ad.id}:rev:1`,
    originalTimer = await h.tx.run(async (tx) => {
      await lockRows(tx, "ad", [ad.id]);
      return h.deps.timers.arm(tx, {
        kind: "sla.breach",
        subject: { type: "ad", id: ad.id },
        key,
        fireAt: due.dueAt,
        entityId: ad.entityId,
        storeId: ad.storeId,
        payload: { purpose: "revision", revisionNo: 1, dueAt: due.dueAt.toISOString() },
      });
    });
  const unchangedTables = [
      "billing_account",
      "point_lot",
      "point_hold",
      "point_hold_alloc",
      "ledger_operation",
      "point_ledger_entry",
      "file_object",
      "production_record",
      "media_info",
      "media_check",
      "ad_version",
    ],
    unchanged = await snapshotTables(h.prisma, unchangedTables),
    date = addDays(calendarDate(now), 1),
    year = Number(date.slice(0, 4)),
    exceptions = (
      await h.prisma.workCalendarDay.findMany({
        where: {
          day: { gte: new Date(`${year}-01-01`), lt: new Date(`${year + 1}-01-01`) },
          kind: { in: ["holiday", "adjusted_workday"] },
        },
        orderBy: { day: "asc" },
      })
    )
      .filter((day) => calendarDate(day.day) !== date)
      .map((day) => ({
        date: day.day.toISOString().slice(0, 10),
        kind: day.kind as "holiday" | "adjusted_workday",
        note: day.note ?? "原日历安排",
      }));
  const imported = await createCalendarAdmin(h.core).import(
    { staff: production.actor.staff!, identity: production.actor.identity },
    {
      year,
      source: "W505修改轮次时限回归",
      days: [...exceptions, { date, kind: "holiday", note: "测试新增工作日放假" }],
    },
  );
  expect(imported.isChanged).toBe(true);
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: {
        eventType: "calendar.imported",
        payload: { path: ["calendarVersion"], equals: imported.calendarVersion },
      },
      orderBy: { seq: "desc" },
    }),
    payload = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload),
    events = createEvents({
      tx: h.tx,
      clock: h.clock,
      assembly: {
        subscribers: h.assembly.subscribers.filter(
          (subscriber) => subscriber.name === "order.onCalendarImported",
        ),
      },
    });
  async function dispatch(eventId: string) {
    await events.expand(200);
    const batch = await h.tx.run((tx) => claimDeliveries(tx, 200));
    expect(
      batch.claimed.some(
        (ref) => ref.eventId === eventId && ref.subscriber === "order.onCalendarImported",
      ),
    ).toBe(true);
    for (const ref of batch.claimed)
      expect(
        await consumeDelivery(
          {
            tx: h.tx,
            subscribers: events.subscribers,
            alerts: {
              raise: async (alert) => {
                h.alerts.push(alert);
              },
            },
          },
          ref,
        ),
      ).toBe("done");
  }
  await dispatch(event.id);
  const current = await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } }),
    revised = await h.prisma.adRevision.findUniqueOrThrow({ where: { id: revision.id } }),
    timers = await h.prisma.timer.findMany({
      where: { subjectType: "ad", subjectId: ad.id, dedupeKey: key, status: "scheduled" },
    });
  expect(revised.dueAt.getTime()).toBeGreaterThan(due.dueAt.getTime());
  expect(current).toMatchObject({
    status: "revising",
    dueAt: revised.dueAt,
    firstBreachedAt,
    firstDueAt: ad.firstDueAt,
    confirmedVersionNo: null,
    confirmedAt: null,
    slaSnapshot: { calendarVersion: imported.calendarVersion },
  });
  expect(revised).toMatchObject({ breachedAt: null, fulfilledByVersionNo: null });
  expect(timers).toEqual([
    expect.objectContaining({
      fireAt: revised.dueAt,
      payload: { purpose: "revision", revisionNo: 1, dueAt: revised.dueAt.toISOString() },
    }),
  ]);
  expect(timers[0]!.id).not.toBe(originalTimer.id);
  expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: originalTimer.id } })).toMatchObject(
    { status: "cancelled" },
  );
  const after = await snapshotTables(h.prisma, ["ad", "ad_revision", "timer", "audit_log"]),
    replay = await h.tx.run((tx) =>
      events.emit(
        tx,
        createIdentityContext({
          actor: { type: "system", job: "lyxtest.calendar_revision_replay" },
        }),
        { type: "calendar.imported", payload },
      ),
    );
  expect(replay.emitted).toBe(true);
  await dispatch(replay.id!);
  assertSnapshotsEqual(
    after,
    await snapshotTables(h.prisma, ["ad", "ad_revision", "timer", "audit_log"]),
  );
  assertSnapshotsEqual(unchanged, await snapshotTables(h.prisma, unchangedTables));
}, 120_000);
