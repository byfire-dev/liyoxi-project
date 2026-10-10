import { Prisma, createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIdentityContext, createTxRunner, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { checked } from "./machines.js";
import {
  holdCancelReviewPauses,
  readCancelReviewHoldTargets,
  readCancelReviewPauseTargets,
  releaseCancelReviewPauses,
} from "./index.js";

const db = useSeededDatabase("services", { max: 1 });
let h: Harness, other: PrismaClient;
let sequence = 91000;
beforeAll(async () => {
  h = harness(await db.prisma());
  other = createPrismaClient({ connectionString: await db.url(), max: 1 });
}, 120000);
beforeEach(() => h.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(async () => {
  h?.unbind();
  await other?.$disconnect();
});
type Order = Awaited<ReturnType<Harness["order"]>>;
type Source = Pick<Tx, "approvalRequest" | "cancelRequest" | "cancelRequestLine">;
async function cause(
  o: Order,
  qualification = false,
  dbx: Source = h.prisma,
  selected = o.items.map((i) => i.id),
  invalid?: "domain" | "subject" | "scope",
) {
  const staff = { id: o.order.deliveryManagerId! },
    now = h.clock.now(),
    id = uuidv7(),
    approvalId = uuidv7();
  const ctx = createIdentityContext({
    actor: qualification
      ? { type: "system", job: "lyxtest.qualification_cancel" }
      : { type: "staff", id: staff.id, client: "admin" },
  });
  const kind = qualification ? "qualification_cancel" : "order_cancel";
  await dbx.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK20260105${sequence++}`,
      kind,
      category: "approval",
      subjectType: qualification ? "store" : "drama_order",
      subjectId: invalid === "subject" ? uuidv7() : qualification ? o.store.id : o.order.id,
      entityId: o.entity.id,
      storeId:
        invalid === "scope" ? (await h.make.store({ entityId: o.entity.id })).id : o.store.id,
      status: "pending",
      summarySnapshot: {
        title: "真实取消暂停关联",
        domain: { type: "cancel_request", id: invalid === "domain" ? uuidv7() : id },
      },
      submitActorType: ctx.actor.type,
      submitActorId: ctx.actor.id,
      submitClient: ctx.actor.client,
      requesterStaffId: staff.id,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await dbx.cancelRequest.create({
    data: {
      id,
      approvalRequestId: approvalId,
      kind,
      entityId: o.entity.id,
      storeId: o.store.id,
      dramaOrderId: qualification ? null : o.order.id,
      reasonCode: qualification ? "qualification_final" : "merchant_request",
      note: "真实取消暂停测试",
      lineCount: selected.length,
      totalBasePoints: 100 * selected.length,
      totalDeductPoints: 0,
      totalRefundPoints: 100 * selected.length,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const targetId of selected) {
    const item = o.items.find((i) => i.id === targetId)!;
    await dbx.cancelRequestLine.create({
      data: {
        id: uuidv7(),
        cancelRequestId: id,
        entityId: o.entity.id,
        storeId: o.store.id,
        targetType: "order_item",
        targetId,
        pointHoldId: item.pointHoldId,
        mode: "refund",
        stage: "ad_and_sample",
        stepAtSubmit: "sample_making",
        reasonClass: qualification ? "qualification" : "merchant",
        chargePoints: 100,
        priorRequestedPoints: 0,
        ratioBp: 0,
        deductPoints: 0,
        refundPoints: 100,
        previewSnapshot: { test: "owner association only" },
        createdAt: now,
      },
    });
  }
  return { id, approvalId, ctx };
}
type Cause = Awaited<ReturnType<typeof cause>>;
async function clocks(o: Order, remaining: number | null = 30, step = "sample_making") {
  const now = h.clock.now(),
    dueAt = remaining === null ? null : new Date(now.getTime() + remaining * 60000);
  const snapshot = {
    policy: `ticket.${step}`,
    amount: 2,
    unit: "work_days",
    calendarVersion: 1,
    computedAt: now.toISOString(),
  };
  for (const id of o.deliveryTicketIds) {
    const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } });
    const current = await h.prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: id, completedAt: null },
    });
    expect(current).toHaveLength(1);
    const stage = current[0]!;
    expect(stage.step).toBe(ticket.step);
    const historical = await h.prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: id, id: { not: stage.id } },
      orderBy: { id: "asc" },
    });
    const maximum = await h.prisma.deliveryTicketStage.aggregate({
      where: { deliveryTicketId: id, step },
      _max: { visitNo: true },
    });
    const visitNo = stage.step === step ? stage.visitNo : (maximum._max.visitNo ?? 0) + 1;
    await h.prisma.deliveryTicketStage.update({
      where: {
        id: stage.id,
        deliveryTicketId: id,
        step: ticket.step,
        visitNo: stage.visitNo,
        completedAt: null,
      },
      data: { step, visitNo, dueAt, slaSnapshot: remaining === null ? Prisma.DbNull : snapshot },
    });
    await h.prisma.deliveryTicket.update({ where: { id }, data: { step, stepDueAt: dueAt } });
    expect(
      await h.prisma.deliveryTicketStage.findMany({
        where: { deliveryTicketId: id, id: { not: stage.id } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(historical);
  }
  return snapshot;
}
async function hold(t: Tx, c: Cause) {
  return holdCancelReviewPauses(
    t,
    h.deps,
    c.ctx,
    await readCancelReviewHoldTargets(t, h.assembly, c.approvalId),
  );
}
async function release(t: Tx, c: Cause) {
  return releaseCancelReviewPauses(t, h.deps, c.ctx, {
    targets: await readCancelReviewPauseTargets(t, [c.approvalId]),
    releaseEvent: "withdrawn",
  });
}
async function ticket(o: Order) {
  return h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: o.deliveryTicketIds[0]! } });
}
async function snapshot(o: Order) {
  return {
    ticket: await ticket(o),
    pauses: await h.prisma.deliveryTicketPause.findMany({
      where: { deliveryTicketId: o.deliveryTicketIds[0] },
      orderBy: { id: "asc" },
    }),
    stages: await h.prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: o.deliveryTicketIds[0] },
      orderBy: { id: "asc" },
    }),
    counts: await h.tx.run((t) => h.counts(t, o.deliveryTicketIds[0]!)),
    timers: await h.prisma.timer.findMany({
      where: { entityId: o.entity.id },
      orderBy: { id: "asc" },
    }),
  };
}
async function approved(c: Cause) {
  await h.prisma.approvalRequest.update({
    where: { id: c.approvalId },
    data: {
      status: "approved",
      isDecidedBySystem: true,
      decidedAt: h.clock.now(),
    },
  });
  await h.prisma.cancelRequest.update({
    where: { id: c.id },
    data: {
      status: "pending_execution",
      execDueAt: new Date(h.clock.now().getTime() + 60000),
      slaSnapshot: {
        policy: "cancel.exec",
        amount: 1,
        unit: "work_minutes",
        calendarVersion: 1,
        computedAt: h.clock.now().toISOString(),
      },
    },
  });
}
async function prelock(t: Tx, refs: Cause[]) {
  const graphs = await Promise.all(
    refs.map((c) => readCancelReviewHoldTargets(t, h.assembly, c.approvalId)),
  );
  for (const [table, ids] of [
    ["approval_request", graphs.map((g) => g.cause.approvalRequestId)],
    ["cancel_request", graphs.map((g) => g.cause.requestId)],
    ["cancel_request_line", graphs.flatMap((g) => [...g.cause.lineIds])],
    ["entity", graphs.map((g) => g.cause.entityId)],
    ["store", graphs.map((g) => g.cause.storeId)],
    ["drama", graphs.flatMap((g) => g.dramaIds)],
    ["drama_order", graphs.flatMap((g) => g.dramaOrderIds)],
    ["order_item", graphs.flatMap((g) => g.orderItemIds)],
    ["delivery_ticket", graphs.flatMap((g) => g.deliveryTicketIds)],
  ] as const)
    await lockRows(t, table, ids);
  return graphs;
}
describe("真实取消原因同事务暂停", { timeout: 60000 }, () => {
  it.each([
    "assigning",
    "plan_confirm",
    "ad_prep",
    "sample_making",
    "sample_confirm",
    "batch_compose",
    "delivering",
    "awaiting_launch",
    "launch_verify",
  ])("第1–9步 %s 正式hold同状态历史", async (step) => {
    const o = await h.order(true);
    await clocks(o, 30, step);
    const c = await cause(o);
    expect(await h.tx.run((t) => hold(t, c))).toEqual({ held: 1 });
    expect(await ticket(o)).toMatchObject({
      step,
      pauseCount: 1,
      pausedAt: h.clock.now(),
      pauseRemainingMin: 30,
    });
    expect(
      await h.prisma.statusTransition.findFirstOrThrow({
        where: { subjectId: o.deliveryTicketIds[0], event: "ticket.hold" },
      }),
    ).toMatchObject({
      fromState: step,
      toState: step,
      actorType: "staff",
      actorId: c.ctx.actor.id,
    });
  });
  it("只读图零写；首次记录真实actor、严格事件及原策略，精确取消当前stage时钟", async () => {
    const o = await h.order(true),
      original = await clocks(o),
      c = await cause(o),
      id = o.deliveryTicketIds[0]!;
    const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: id, completedAt: null },
    });
    const timers = createTimers({ assembly: h.assembly });
    const armed = await h.tx.run(async (t) => {
      await lockRows(t, "delivery_ticket", [id]);
      const own = await timers.arm(t, {
        kind: "sla.breach",
        subject: { type: "delivery_ticket_stage", id: stage.id },
        key: timerKey("sla.breach", { type: "delivery_ticket_stage", id: stage.id }),
        fireAt: stage.dueAt!,
      });
      const unrelated = await timers.arm(t, {
        kind: "usage.end",
        subject: { type: "order_item", id: o.items[0]!.id },
        key: timerKey("usage.end", { type: "order_item", id: o.items[0]!.id }),
        fireAt: stage.dueAt!,
      });
      return { own, unrelated };
    });
    const before = await snapshot(o);
    await h.tx.run((t) => readCancelReviewHoldTargets(t, h.assembly, c.approvalId));
    expect(await snapshot(o)).toEqual(before);
    expect(await h.tx.run((t) => hold(t, c))).toEqual({ held: 1 });
    expect((await ticket(o)).lockVersion).toBe(before.ticket.lockVersion + 1);
    expect(
      await h.prisma.deliveryTicketPause.findFirstOrThrow({ where: { refId: c.approvalId } }),
    ).toMatchObject({
      actorType: "staff",
      actorId: c.ctx.actor.id,
      client: "admin",
      refType: "approval_request",
      releasedAt: null,
    });
    expect(
      await h.prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: id, eventType: "ticket.held" },
      }),
    ).toMatchObject({
      payload: {
        v: 1,
        deliveryTicketId: id,
        orderItemId: o.items[0]!.id,
        reason: "cancel_review",
        refId: c.approvalId,
        fromState: "sample_making",
        toState: "sample_making",
        transition: "ticket.hold",
      },
    });
    expect(
      (await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: stage.id } }))
        .slaSnapshot,
    ).toEqual(original);
    expect((await h.prisma.timer.findUniqueOrThrow({ where: { id: armed.own.id } })).status).toBe(
      "cancelled",
    );
    expect(
      (await h.prisma.timer.findUniqueOrThrow({ where: { id: armed.unrelated.id } })).status,
    ).toBe("scheduled");
  });
  it.each([false, true])("pending/approved=%s 相同active原因重放完全零写", async (done) => {
    const o = await h.order(true);
    await clocks(o);
    const c = await cause(o);
    await h.tx.run((t) => hold(t, c));
    if (done) await approved(c);
    const before = await snapshot(o);
    expect(await h.tx.run((t) => hold(t, c))).toEqual({ held: 0 });
    expect(await snapshot(o)).toEqual(before);
  });
  it("已approved不得首次制造暂停", async () => {
    const o = await h.order(true);
    await clocks(o);
    const c = await cause(o);
    await approved(c);
    const before = await snapshot(o);
    await expect(h.tx.run((t) => hold(t, c))).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await snapshot(o)).toEqual(before);
  });
  it.each([null, 0, -15])("无时限/零/过期=%s 保存null或0，不覆盖原阶段快照", async (remaining) => {
    const o = await h.order(true),
      original = await clocks(o, remaining),
      c = await cause(o);
    await h.tx.run((t) => hold(t, c));
    expect((await ticket(o)).pauseRemainingMin).toBe(remaining === null ? null : 0);
    expect(
      (
        await h.prisma.deliveryTicketStage.findFirstOrThrow({
          where: { deliveryTicketId: o.deliveryTicketIds[0], completedAt: null },
        })
      ).slaSnapshot,
    ).toEqual(remaining === null ? null : original);
  });
  it("只选真实明细；未选项不动，后续上线步骤不加入新暂停", async () => {
    const o = await h.order(true, 3);
    await clocks(o);
    await h.prisma.deliveryTicket.update({
      where: { id: o.deliveryTicketIds[1] },
      data: { step: "in_service" },
    });
    const c = await cause(
      o,
      false,
      h.prisma,
      o.items.slice(0, 2).map((i) => i.id),
    );
    expect(await h.tx.run((t) => hold(t, c))).toEqual({ held: 1 });
    expect(
      (
        await h.prisma.deliveryTicket.findMany({
          where: { id: { in: o.deliveryTicketIds } },
          orderBy: { orderItemId: "asc" },
        })
      )
        .map((t) => t.pauseCount)
        .sort(),
    ).toEqual([0, 0, 1]);
  });
  it("两个真实申请叠加保第一时刻/剩余值，最后释放才恢复及调用真实reevaluate", async () => {
    const o = await h.order(true);
    await clocks(o, 30, "awaiting_launch");
    const first = await cause(o),
      second = await cause(o, true);
    await h.tx.run((t) => hold(t, first));
    const paused = await ticket(o);
    h.clock.advance(10 * 60000);
    await h.tx.run((t) => hold(t, second));
    expect(await ticket(o)).toMatchObject({
      pauseCount: 2,
      pausedAt: paused.pausedAt,
      pauseRemainingMin: 30,
    });
    const callbacks = h.rederivations.length;
    expect(await h.tx.run((t) => release(t, first))).toEqual({ released: 1, resumedTicketIds: [] });
    expect((await ticket(o)).pauseCount).toBe(1);
    expect(h.rederivations).toHaveLength(callbacks);
    expect((await h.tx.run((t) => release(t, second))).resumedTicketIds).toEqual(
      o.deliveryTicketIds,
    );
    expect(await ticket(o)).toMatchObject({
      pauseCount: 0,
      pausedAt: null,
      pauseRemainingMin: null,
      stepDueAt: new Date(h.clock.now().getTime() + 30 * 60000),
    });
    expect(h.rederivations).toHaveLength(callbacks + 1);
  });
  it("保留plan_amendment及其原暂停快照，释放cancel原因不会恢复", async () => {
    const o = await h.order(true);
    await clocks(o);
    const c = await cause(o),
      id = o.deliveryTicketIds[0]!;
    const plan = await h.prisma.deliveryTicketPause.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: id,
        reason: "plan_amendment",
        refType: "delivery_plan_version",
        refId: uuidv7(),
        actorType: "system",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.prisma.deliveryTicket.update({
      where: { id },
      data: { pauseCount: 1, pausedAt: h.clock.now(), pauseRemainingMin: 17 },
    });
    await h.tx.run((t) => hold(t, c));
    await h.tx.run((t) => release(t, c));
    expect(await ticket(o)).toMatchObject({ pauseCount: 1, pauseRemainingMin: 17 });
    expect(
      (await h.prisma.deliveryTicketPause.findUniqueOrThrow({ where: { id: plan.id } })).releasedAt,
    ).toBeNull();
  });
  it("真实申请/明细未提交也在同Tx可见，外部连接提交前看不到暂停", async () => {
    const o = await h.order(true);
    await clocks(o);
    await h.tx.run(async (t) => {
      const c = await cause(o, false, t);
      expect(await hold(t, c)).toEqual({ held: 1 });
      expect(await t.deliveryTicketPause.count({ where: { refId: c.approvalId } })).toBe(1);
      expect(await other.deliveryTicketPause.count({ where: { refId: c.approvalId } })).toBe(0);
    });
    expect((await ticket(o)).pauseCount).toBe(1);
  });
  it("外层失败回滚原因/汇总/历史/事件/timer/阶段，真实申请同样回滚", async () => {
    const o = await h.order(true);
    await clocks(o);
    const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: o.deliveryTicketIds[0], completedAt: null },
    });
    await h.tx.run(async (t) => {
      await lockRows(t, "delivery_ticket", o.deliveryTicketIds);
      await createTimers({ assembly: h.assembly }).arm(t, {
        kind: "sla.breach",
        subject: { type: "delivery_ticket_stage", id: stage.id },
        key: timerKey("sla.breach", { type: "delivery_ticket_stage", id: stage.id }),
        fireAt: stage.dueAt!,
      });
    });
    const before = await snapshot(o);
    let approvalId = "";
    await expect(
      h.tx.run(async (t) => {
        const c = await cause(o, false, t);
        approvalId = c.approvalId;
        await hold(t, c);
        throw new Error("outer abort");
      }),
    ).rejects.toThrow("outer abort");
    expect(await snapshot(o)).toEqual(before);
    expect(await h.prisma.approvalRequest.findUnique({ where: { id: approvalId } })).toBeNull();
  });
  it("原已释放cause不得复活", async () => {
    const o = await h.order(true);
    await clocks(o);
    const c = await cause(o);
    await h.tx.run((t) => hold(t, c));
    await h.tx.run((t) => release(t, c));
    const before = await snapshot(o);
    await expect(h.tx.run((t) => hold(t, c))).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await snapshot(o)).toEqual(before);
  });
  it("多工单后项失败时前项暂停和副作用全部回滚", async () => {
    const o = await h.order(true, 2);
    await clocks(o);
    const c = await cause(o);
    await h.prisma.deliveryTicketStage.updateMany({
      where: { deliveryTicketId: [...o.deliveryTicketIds].sort()[1], completedAt: null },
      data: { slaSnapshot: { policy: "broken" } },
    });
    const before = await snapshot(o);
    await expect(h.tx.run((t) => hold(t, c))).rejects.toThrow();
    expect(await snapshot(o)).toEqual(before);
    expect(await h.prisma.deliveryTicketPause.count({ where: { refId: c.approvalId } })).toBe(0);
  });
  it.each(["staff", "system", "merchant"])("错误实际提交actor %s 不可借用cause", async (type) => {
    const o = await h.order(true);
    await clocks(o);
    const c = await cause(o);
    const ctx = createIdentityContext({
      actor:
        type === "system"
          ? { type, job: "lyxtest.fake" }
          : { type: type as "staff" | "merchant", id: uuidv7(), client: "admin" },
    });
    const before = await snapshot(o);
    await expect(
      h.tx.run(async (t) =>
        holdCancelReviewPauses(
          t,
          h.deps,
          ctx,
          await readCancelReviewHoldTargets(t, h.assembly, c.approvalId),
        ),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await snapshot(o)).toEqual(before);
  });
  it.each(["domain", "subject", "scope", "closed", "missing"])(
    "实际审批/申请关联 %s 拒绝",
    async (failure) => {
      const o = await h.order(true);
      await clocks(o);
      const c = await cause(
        o,
        false,
        h.prisma,
        o.items.map((i) => i.id),
        failure === "domain" || failure === "subject" || failure === "scope" ? failure : undefined,
      );
      if (failure === "closed")
        await h.prisma.cancelRequest.update({
          where: { id: c.id },
          data: { status: "not_executed", closedAt: h.clock.now(), closeReason: "withdrawn" },
        });
      if (failure === "missing") c.approvalId = uuidv7();
      await expect(h.tx.run((t) => hold(t, c))).rejects.toMatchObject({
        error: "STATE_NOT_ALLOWED",
      });
      expect((await ticket(o)).pauseCount).toBe(0);
    },
  );
  it.each(["stage", "cause", "line"])("预读后 %s 图变化原子拒绝", async (change) => {
    const o = await h.order(true, 2);
    await clocks(o);
    const c = await cause(o, false, h.prisma, [o.items[0]!.id]);
    const graph = await h.tx.run((t) => readCancelReviewHoldTargets(t, h.assembly, c.approvalId));
    if (change === "stage")
      await h.prisma.deliveryTicketStage.updateMany({
        where: { deliveryTicketId: o.deliveryTicketIds[0], completedAt: null },
        data: { isBreached: true },
      });
    if (change === "cause")
      await h.prisma.deliveryTicketPause.create({
        data: {
          id: uuidv7(),
          deliveryTicketId: o.deliveryTicketIds[0]!,
          reason: "plan_amendment",
          refType: "delivery_plan_version",
          refId: uuidv7(),
          actorType: "system",
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
    if (change === "line")
      await h.prisma.cancelRequestLine.create({
        data: {
          id: uuidv7(),
          cancelRequestId: c.id,
          entityId: o.entity.id,
          storeId: o.store.id,
          targetType: "order_item",
          targetId: o.items[1]!.id,
          pointHoldId: o.items[1]!.pointHoldId,
          mode: "refund",
          stage: "ad_and_sample",
          stepAtSubmit: "sample_making",
          reasonClass: "merchant",
          chargePoints: 100,
          priorRequestedPoints: 0,
          ratioBp: 0,
          deductPoints: 0,
          refundPoints: 100,
          previewSnapshot: {},
          createdAt: h.clock.now(),
        },
      });
    const before = await snapshot(o);
    await expect(
      h.tx.run((t) => holdCancelReviewPauses(t, h.deps, c.ctx, graph)),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await snapshot(o)).toEqual(before);
  });
  it.each(["count", "stage", "snapshot", "deadline"])(
    "不一致 %s 不提交任何暂停",
    async (change) => {
      const o = await h.order(true);
      await clocks(o);
      const c = await cause(o),
        id = o.deliveryTicketIds[0]!;
      if (change === "count")
        await h.prisma.deliveryTicket.update({
          where: { id },
          data: { pauseCount: 1, pausedAt: h.clock.now(), pauseRemainingMin: 30 },
        });
      if (change === "stage")
        await h.prisma.deliveryTicketStage.updateMany({
          where: { deliveryTicketId: id, completedAt: null },
          data: { step: "ad_prep" },
        });
      if (change === "snapshot")
        await h.prisma.deliveryTicketStage.updateMany({
          where: { deliveryTicketId: id, completedAt: null },
          data: { slaSnapshot: { policy: "broken" } },
        });
      if (change === "deadline")
        await h.prisma.deliveryTicket.update({
          where: { id },
          data: { stepDueAt: new Date(h.clock.now().getTime() + 60000) },
        });
      const before = await snapshot(o);
      await expect(h.tx.run((t) => hold(t, c))).rejects.toThrow();
      expect(await snapshot(o)).toEqual(before);
    },
  );
  it("不能直接用普通checked替代专用hold守卫", async () => {
    const o = await h.order(true);
    await clocks(o);
    await expect(
      h.tx.run((t) =>
        h.flow.transition(t, o.viewer.ctx, {
          machine: "delivery_ticket",
          stateField: "step",
          id: o.deliveryTicketIds[0]!,
          event: "ticket.hold",
          to: "sample_making",
          ref: "10:189",
          set: { pause_count: 1, paused_at: h.clock.now(), pause_remaining_min: 30 },
          args: checked(),
          emit: {
            type: "ticket.held",
            payload: {
              v: 1,
              deliveryTicketId: o.deliveryTicketIds[0]!,
              orderItemId: o.items[0]!.id,
              reason: "cancel_review",
              refId: uuidv7(),
            },
          },
        }),
      ),
    ).rejects.toThrow();
    expect((await ticket(o)).pauseCount).toBe(0);
  });
  it("缺真实订单facts拥有者时fail-closed，不以空集合假成功", async () => {
    const unbound = harness(h.prisma, false);
    try {
      await expect(
        h.tx.run((t) => readCancelReviewHoldTargets(t, unbound.assembly, uuidv7())),
      ).rejects.toMatchObject({ error: "INTERNAL" });
    } finally {
      unbound.unbind();
    }
  });
  it("全图预锁后持有高序plan，多个申请逐个持有原因仍无低序补锁", async () => {
    const o = await h.order(true);
    await clocks(o);
    const first = await cause(o),
      second = await cause(o, true);
    await h.tx.run(async (t) => {
      await prelock(t, [first, second]);
      await lockRows(t, "delivery_plan", [o.deliveryPlanId]);
      expect(await hold(t, first)).toEqual({ held: 1 });
      expect(await hold(t, second)).toEqual({ held: 1 });
    });
    expect((await ticket(o)).pauseCount).toBe(2);
  });
  it("两连接同cause竞争：一成功一图变化拒绝，整笔重读后零写重放", async () => {
    const o = await h.order(true);
    await clocks(o);
    const c = await cause(o);
    const runner = createTxRunner({ prisma: other, appEnv: "test" });
    let arrived = 0,
      open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const results = await Promise.allSettled(
      [h.tx, runner].map((r) =>
        r.run(async (t) => {
          const graph = await readCancelReviewHoldTargets(t, h.assembly, c.approvalId);
          if (++arrived === 2) open();
          await gate;
          return holdCancelReviewPauses(t, h.deps, c.ctx, graph);
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "STATE_NOT_ALLOWED" },
    });
    expect(await h.tx.run((t) => hold(t, c))).toEqual({ held: 0 });
    expect((await ticket(o)).pauseCount).toBe(1);
    expect(await h.prisma.deliveryTicketPause.count({ where: { refId: c.approvalId } })).toBe(1);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.deliveryTicketIds[0], eventType: "ticket.held" },
      }),
    ).toBe(1);
  });
  it("两连接不同cause竞争保持计数，失败方整笔重读后成功叠加", async () => {
    const o = await h.order(true);
    await clocks(o);
    const causes = [await cause(o), await cause(o, true)];
    const runner = createTxRunner({ prisma: other, appEnv: "test" });
    let arrived = 0,
      open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const results = await Promise.allSettled(
      [h.tx, runner].map((r, i) =>
        r.run(async (t) => {
          const c = causes[i]!,
            graph = await readCancelReviewHoldTargets(t, h.assembly, c.approvalId);
          if (++arrived === 2) open();
          await gate;
          return holdCancelReviewPauses(t, h.deps, c.ctx, graph);
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.findIndex((r) => r.status === "rejected");
    expect(results[failed]).toMatchObject({ reason: { error: "STATE_NOT_ALLOWED" } });
    expect(await h.tx.run((t) => hold(t, causes[failed]!))).toEqual({ held: 1 });
    expect((await ticket(o)).pauseCount).toBe(2);
  });
  it("等待预锁时新增原因，锁后图复核拒绝而不追加任何低序锁", async () => {
    const o = await h.order(true);
    await clocks(o);
    const first = await cause(o),
      second = await cause(o, true);
    const graph = await h.tx.run((t) =>
      readCancelReviewHoldTargets(t, h.assembly, second.approvalId),
    );
    const runner = createTxRunner({ prisma: other, appEnv: "test" });
    let entered!: () => void, finish!: () => void;
    const locked = new Promise<void>((r) => {
        entered = r;
      }),
      proceed = new Promise<void>((r) => {
        finish = r;
      });
    const writer = runner.run(async (t) => {
      await hold(t, first);
      entered();
      await proceed;
    });
    await locked;
    const observer = createPrismaClient({ connectionString: await db.url(), max: 1 });
    let pid = 0,
      started!: () => void;
    const connected = new Promise<void>((r) => {
      started = r;
    });
    const waiting = h.tx
      .run(async (t) => {
        const [backend] = await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pid = backend!.pid;
        started();
        return holdCancelReviewPauses(t, h.deps, second.ctx, graph);
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await connected;
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [backend] = await observer.$queryRaw<{ waiting: boolean }[]>`
          SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`;
        if (backend?.waiting) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
      finish();
      await writer;
      expect(await waiting).toMatchObject({ error: { error: "STATE_NOT_ALLOWED" } });
      expect(
        await h.prisma.deliveryTicketPause.count({ where: { refId: second.approvalId } }),
      ).toBe(0);
    } finally {
      finish();
      await writer;
      await waiting;
      await observer.$disconnect();
    }
  });
});
