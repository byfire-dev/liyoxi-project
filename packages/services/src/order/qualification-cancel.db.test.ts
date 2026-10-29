import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FinalRejectImpact } from "@liyoxi/contract";
import { createRuntime, loadEnv } from "../index.js";
import {
  assertSnapshotsEqual,
  fakeKeyEnv,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { submitQualificationFixture as submit } from "../testing/index.js";
import { body, drama } from "./__fixtures__/harness.js";
import { MONEY_TABLES, REQUEST_TABLES, requestsHarness } from "./__fixtures__/cancel-requests.js";
import type { RequestsHarness } from "./__fixtures__/cancel-requests.js";
import { startOrder } from "./start.js";

const db = useSeededDatabase("services", { max: 1 });
const redis = useTestRedis();
let h: RequestsHarness;
let runtime: ReturnType<typeof createRuntime>;
const DAY = 86400000;
beforeAll(async () => {
  h = requestsHarness(await db.prisma());
  await redis.raw();
  runtime = createRuntime({
    entry: "api",
    version: "lyxtest-w502-qualification",
    clock: h.clock,
    providers: h.fake,
    redisKeyPrefix: redis.prefix,
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    },
  });
}, 120000);
afterAll(async () => {
  await runtime?.close();
  await h?.close();
}, 120000);
type World = Awaited<ReturnType<RequestsHarness["qualificationOrder"]>>;
async function reject(w: World, roundId = w.submissionId, roundNo = 1) {
  const actor = await h.staff();
  await h.profile.admin.reject(actor.ctx, actor.staff!, roundId, {
    isFinal: false,
    confirm: { roundNo },
    reasonCodes: ["R01"],
    note: "资质材料需要补正",
  });
  await h.deliver(w.store.id);
  return h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id: roundId } });
}
async function timer(orderId: string, roundNo = 1) {
  return h.prisma.timer.findFirstOrThrow({
    where: {
      subjectId: orderId,
      kind: "order.rejected_stale",
      dedupeKey: { endsWith: `:r${roundNo}` },
    },
  });
}
async function fire(row: Awaited<ReturnType<typeof timer>>) {
  const handler = h.assembly.timerHandler("order.rejected_stale")!;
  return h.tx.run((tx) =>
    handler.handle(tx, {
      id: row.id,
      kind: row.kind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      payload: row.payload as Record<string, unknown> | null,
    }),
  );
}
async function resubmit(w: World) {
  const draft = await h.profile.updateQualification(w.viewer, {
    lockVersion: null,
    declarationConfirmed: true,
    declarationVersion: "1",
  });
  const id = draft.openRound!.qualificationSubmissionId;
  await submit(h.profileFixture, w.viewer, id);
  return h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id } });
}
function finalConfirm(impact: FinalRejectImpact) {
  return {
    pendingStartOrderCount: impact.pendingStartOrderCount,
    pendingAssignAdCount: impact.pendingAssignAdCount,
    heldPoints: impact.heldPoints,
  };
}
async function consumeReminder(event: { id: string; eventType: string; payload: unknown }) {
  return runtime.tx.run((tx) =>
    runtime.notify.onEvent(tx, {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    }),
  );
}

describe("W5-02 真实资质轮次驱动取消与七日跟进", { timeout: 120000 }, () => {
  it("非终局当前轮次严格七自然日；到点只发客服待办事实且重复不退款不终止", async () => {
    const w = await h.qualificationOrder();
    const lead = await h.make.staff({ staffRoleKey: "cs", isLead: true });
    const ordinary = await h.make.staff({ staffRoleKey: "cs", isLead: false });
    const disabledLead = await h.make.staff({
      staffRoleKey: "cs",
      isLead: true,
      status: "disabled",
      disabledReason: "other",
      disabledAt: h.clock.now(),
    });
    const otherRoleLead = await h.make.staff({ staffRoleKey: "delivery_manager", isLead: true });
    const money = await snapshotTables(h.prisma, MONEY_TABLES);
    const round = await reject(w);
    const t = await timer(w.id);
    expect(t.fireAt).toEqual(new Date(round.closedAt!.getTime() + 7 * DAY));
    expect(await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({
      status: "pending_start",
      subStatus: "qualification_rejected",
      openCancelRequestId: null,
    });
    expect(await h.prisma.cancelRequest.count({ where: { storeId: w.store.id } })).toBe(0);
    h.clock.set(new Date(t.fireAt.getTime() - 1));
    expect(await fire(t)).toBe("skipped");
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: w.id, eventType: "order.rejected_stale" },
      }),
    ).toBe(0);
    h.clock.set(t.fireAt);
    expect(await fire(t)).toBe("fired");
    await fire(t);
    const events = await h.prisma.outboxEvent.findMany({
      where: { aggregateId: w.id, eventType: "order.rejected_stale" },
    });
    expect(events).toEqual([
      expect.objectContaining({
        dedupeKey: `tmr:${t.dedupeKey}`,
        payload: expect.objectContaining({
          dramaOrderId: w.id,
          storeId: w.store.id,
          rejectedAt: round.closedAt!.toISOString(),
        }),
      }),
    ]);
    const event = events[0]!;
    expect(await consumeReminder(event)).toBe(1);
    expect(await consumeReminder(event)).toBe(0);
    const messages = await h.prisma.staffMessage.findMany({
      where: { notification: { sourceOutboxEventId: event.id, notifySceneKey: "s.kf_todo" } },
      include: { notification: true },
    });
    expect(messages).toEqual([
      expect.objectContaining({
        staffId: lead.id,
        kind: "todo",
        link: { route: "order.detail", params: { orderId: w.id } },
        notification: expect.objectContaining({
          sourceOutboxEventId: event.id,
          notifySceneKey: "s.kf_todo",
        }),
      }),
    ]);
    expect(
      messages.every(
        (message) => ![ordinary.id, disabledLead.id, otherRoleLead.id].includes(message.staffId),
      ),
    ).toBe(true);
    expect(
      await h.prisma.merchantMessage.count({
        where: { notification: { sourceOutboxEventId: event.id } },
      }),
    ).toBe(0);
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    expect(await h.prisma.deliveryTicket.count({ where: { dramaOrderId: w.id } })).toBe(0);
    expect(await h.prisma.cancelRequest.count({ where: { storeId: w.store.id } })).toBe(0);
  });

  it("新轮次重新提交再驳回，旧轮timer跳过，新轮必须重新满七日", async () => {
    const w = await h.qualificationOrder();
    const firstRound = await reject(w);
    const old = await timer(w.id);
    expect(old.fireAt).toEqual(new Date(firstRound.closedAt!.getTime() + 7 * DAY));
    h.clock.set(old.fireAt);
    expect(await fire(old)).toBe("fired");
    const delayedEvent = await h.prisma.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: w.id,
        eventType: "order.rejected_stale",
      },
    });
    h.clock.advance(1);
    const current = await resubmit(w);
    expect(current.roundNo).toBe(2);
    await reject(w, current.id, 2);
    const newer = await timer(w.id, 2);
    h.clock.set(new Date(newer.fireAt.getTime() - 1));
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    expect(await fire(old)).toBe("skipped");
    expect(await fire(newer)).toBe("skipped");
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    expect(await consumeReminder(delayedEvent)).toBe(0);
    expect(
      await h.prisma.notification.count({ where: { sourceOutboxEventId: delayedEvent.id } }),
    ).toBe(0);
    expect(
      await h.prisma.staffMessage.count({
        where: { notification: { sourceOutboxEventId: delayedEvent.id } },
      }),
    ).toBe(0);
    h.clock.set(newer.fireAt);
    expect(await fire(newer)).toBe("fired");
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: w.id, eventType: "order.rejected_stale" },
      }),
    ).toBe(2);
    const events = await h.prisma.outboxEvent.findMany({
      where: { aggregateId: w.id, eventType: "order.rejected_stale" },
    });
    expect(events.map((event) => event.dedupeKey).sort()).toEqual(
      [`tmr:${old.dedupeKey}`, `tmr:${newer.dedupeKey}`].sort(),
    );
  });

  it("真实新轮资质恢复及实际开工后旧timer均skipped，迟到驳回事件不能重新卡住订单", async () => {
    const w = await h.qualificationOrder();
    await reject(w);
    const oldEvent = await h.prisma.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: w.store.id,
        eventType: "store.qualification.rejected",
      },
    });
    const t = await timer(w.id);
    const next = await resubmit(w);
    const reviewer = await h.staff();
    await h.profile.admin.approve(reviewer.ctx, reviewer.staff!, next.id, {
      lockVersion: 0,
      mode: "normal",
      confirm: { roundNo: 2 },
    });
    await h.deliver(w.store.id, "store.qualification.approved");
    h.clock.set(t.fireAt);
    expect(await fire(t)).toBe("skipped");
    expect(await h.tx.run((tx) => startOrder(tx, h.deps, w.id))).toBe("fired");
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    expect(await fire(t)).toBe("skipped");
    await h.tx.run((tx) =>
      h.assembly.subscriber("order.onQualificationDecided")!.handle(tx, {
        id: oldEvent.id,
        type: oldEvent.eventType,
        payload: oldEvent.payload as Record<string, unknown>,
      }),
    );
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    expect(await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({
      status: "producing",
    });
    expect(await h.prisma.cancelRequest.count({ where: { storeId: w.store.id } })).toBe(0);
  });

  it("终局真实只读影响→整店系统申请；批准前零退款零终止，批准再调W5-01统一执行", async () => {
    const w = await h.qualificationOrder(2);
    const extra = await drama(h, 150);
    const second = await h.order.create(
      w.actor,
      await body({ ...h, deps: h.orderDeps }, w.b, [extra.id]),
    );
    const ad = await h.unassignedAd(w);
    const reviewer = await h.staff();
    await h.param("refund.points.auto_approve_before_production", false, reviewer);
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    const impact = await h.profile.admin.rejectQuote(reviewer.staff!, w.submissionId);
    expect(impact).toMatchObject({
      pendingStartOrderCount: 2,
      pendingAssignAdCount: 1,
      ads: [expect.objectContaining({ adId: ad.id, heldPoints: ad.chargePoints })],
    });
    expect(impact.orders.map((o) => o.orderId).sort()).toEqual([w.id, second.orderId].sort());
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    await h.profile.admin.reject(reviewer.ctx, reviewer.staff!, w.submissionId, {
      isFinal: true,
      reasonCodes: ["R01"],
      note: "资质无法补正的终局结论",
      confirm: finalConfirm(impact),
    });
    const money = await snapshotTables(h.prisma, MONEY_TABLES);
    await h.deliver(w.store.id);
    const r = await h.prisma.cancelRequest.findFirstOrThrow({
      where: { storeId: w.store.id, kind: "qualification_cancel" },
      include: { approvalRequest: true, cancelRequestLines: true },
    });
    expect(r).toMatchObject({
      reasonCode: "qualification_final",
      status: "pending_approval",
      lineCount: 4,
      totalRefundPoints: impact.heldPoints,
      approvalRequest: {
        subjectType: "store",
        subjectId: w.store.id,
        status: "pending",
        submitActorType: "system",
      },
    });
    for (const id of [w.id, second.orderId])
      expect(await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "after_sale",
        openCancelRequestId: r.id,
      });
    expect(
      await h.prisma.orderItem.count({
        where: { dramaOrder: { storeId: w.store.id }, phase: "pending_start" },
      }),
    ).toBe(3);
    expect(await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } })).toMatchObject({
      status: "pending_assign",
      openCancelRequestId: r.id,
    });
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    const afterSubmit = await snapshotTables(h.prisma, REQUEST_TABLES);
    await h.deliver(w.store.id);
    assertSnapshotsEqual(afterSubmit, await snapshotTables(h.prisma, REQUEST_TABLES));
    const approver = await h.staff();
    expect(await h.requests.approve(approver, r.id, await h.approveBody(r.id))).toMatchObject({
      status: "pending_execution",
    });
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    const executor = await h.staff();
    await h.execute(executor, {
      id: r.id,
      confirm: { requestNo: r.approvalRequest.requestNo!, totalRefundPoints: r.totalRefundPoints },
    });
    expect(await h.saved(r.id)).toMatchObject({
      status: "done",
      cancelRequestLines: expect.arrayContaining([
        expect.objectContaining({ mode: "release", executedAt: h.clock.now() }),
      ]),
    });
    expect(
      await h.prisma.orderItem.count({
        where: { dramaOrder: { storeId: w.store.id }, phase: "cancelled" },
      }),
    ).toBe(3);
    expect(
      await h.prisma.dramaOrder.count({
        where: {
          id: { in: [w.id, second.orderId] },
          openCancelRequestId: null,
          status: "cancelled",
        },
      }),
    ).toBe(2);
    expect(await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } })).toMatchObject({
      status: "cancelled",
      openCancelRequestId: null,
    });
    expect(
      await h.prisma.pointHold.findUniqueOrThrow({ where: { id: ad.pointHoldId } }),
    ).toMatchObject({ status: "released" });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: r.id, eventType: "cancel.executed" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: r.approvalRequestId, eventType: "approval.executed" },
      }),
    ).toBe(1);
  });
});
