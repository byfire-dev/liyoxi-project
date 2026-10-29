import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrderCancelRequestCreateBodySchema } from "@liyoxi/contract";
import { assertSnapshotsEqual, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import type { CancelActor } from "./cancel-context.js";
import { voidCancelRequest, withdrawCancelRequest } from "./cancel-decisions.js";
import { startOrder } from "./start.js";
import { createCancelRequests } from "./cancel-requests.js";
import { MONEY_TABLES, REQUEST_TABLES, requestsHarness } from "./__fixtures__/cancel-requests.js";
import type { RequestsHarness } from "./__fixtures__/cancel-requests.js";

const db = useSeededDatabase("services", { max: 1 });
let h: RequestsHarness;
beforeAll(async () => {
  h = requestsHarness(await db.prisma());
}, 120000);
afterAll(async () => h?.close());

async function pending(stage: "pending_start" | "plan_confirm" | "post_sample" = "pending_start") {
  const p = await h.atStage(stage);
  await h.param("refund.points.auto_approve_before_production", false, p.actor);
  return p;
}
const noStepUp = (actor: Awaited<ReturnType<RequestsHarness["staff"]>>) => ({
  ...actor,
  staff: { ...actor.staff!, stepUpAt: null },
});

describe("W5-02 真实订购取消申请与决定", { timeout: 120000 }, () => {
  it("人工原因严格排除资质终局；报价只读，期望金额变化不留下申请或资金写入", async () => {
    const p = await pending();
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    const q = await h.requests.quote(p.actor, p.out.orderId, p.input);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    const input = {
      ...p.input,
      note: "重新核实退款金额",
      expect: { totalRefundPoints: q.totalRefundPoints + 1 },
    };
    await expect(h.requests.create(p.actor, p.out.orderId, input)).rejects.toMatchObject({
      error: "CANCEL_QUOTE_CHANGED",
      details: { quote: { totalRefundPoints: q.totalRefundPoints } },
    });
    expect(
      OrderCancelRequestCreateBodySchema.safeParse({
        ...input,
        reasonCode: "qualification_final",
      }).success,
    ).toBe(false);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
  });

  it("报价后通过真实开工推进阶段，提交旧报价被拒绝且不留下部分申请", async () => {
    const p = await pending();
    const quoted = await h.requests.quote(p.actor, p.out.orderId, p.input);
    expect(await h.tx.run((tx) => startOrder(tx, h.deps, p.out.orderId))).toBe("fired");
    const current = await h.requests.quote(p.actor, p.out.orderId, p.input);
    expect(current.totalRefundPoints).toBeLessThan(quoted.totalRefundPoints);
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    await expect(
      h.requests.create(p.actor, p.out.orderId, {
        ...p.input,
        note: "仍按开工前旧报价申请",
        expect: quoted.expect,
      }),
    ).rejects.toMatchObject({
      error: "CANCEL_QUOTE_CHANGED",
      details: { quote: { totalRefundPoints: current.totalRefundPoints } },
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
  });

  it("真实样片后手工扣除必须逐行有依据，保存申请时重算并保留依据", async () => {
    const p = await pending("post_sample");
    const q = await h.requests.quote(p.actor, p.out.orderId, { reasonCode: "merchant_request" });
    expect(q.needsManualDeduct).toBe(true);
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    await expect(
      h.requests.create(p.actor, p.out.orderId, {
        reasonCode: "merchant_request",
        note: "核实已完成样片成本",
        expect: q.expect,
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    const result = await h.create(p);
    const saved = await h.saved(result.cancelRequestId);
    expect(saved.cancelRequestLines).toEqual([
      expect.objectContaining({
        deductPoints: 37,
        deductNote: "真实已完成样片成本",
        mode: "refund",
      }),
    ]);
    expect(saved.totalDeductPoints).toBe(37);
  });

  it("同幂等键重放同ID，每单唯一在途；申请/明细/审批/父指针同TX且申请不退积分", async () => {
    const p = await pending("plan_confirm");
    const q = await h.requests.quote(p.actor, p.out.orderId, p.input);
    const input = { ...p.input, note: "商家明确申请取消订购", expect: q.expect };
    const key = uuidv7();
    const beforeMoney = await snapshotTables(h.prisma, MONEY_TABLES);
    const result = await h.requests.create(
      p.actor,
      p.out.orderId,
      input,
      h.idem(p.actor, input, key),
    );
    const after = await snapshotTables(h.prisma, REQUEST_TABLES);
    expect(
      await h.requests.create(p.actor, p.out.orderId, input, h.idem(p.actor, input, key)),
    ).toEqual(result);
    assertSnapshotsEqual(after, await snapshotTables(h.prisma, REQUEST_TABLES));
    assertSnapshotsEqual(beforeMoney, await snapshotTables(h.prisma, MONEY_TABLES));
    const saved = await h.saved(result.cancelRequestId);
    expect(saved).toMatchObject({
      kind: "order_cancel",
      status: "pending_approval",
      executedAt: null,
      totalRefundPoints: q.totalRefundPoints,
      approvalRequest: {
        status: "pending",
        requesterStaffId: p.actor.staff!.staff.id,
        submitActorType: "staff",
        submitActorId: p.actor.staff!.staff.id,
        submitClient: "admin",
      },
      cancelRequestLines: [expect.objectContaining({ targetId: p.items[0]!.id, executedAt: null })],
    });
    expect(
      await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: p.out.orderId } }),
    ).toMatchObject({
      status: "after_sale",
      subStatus: "cancel_reviewing",
      openCancelRequestId: saved.id,
    });
    expect(
      await h.prisma.deliveryTicketPause.findMany({ where: { refId: saved.approvalRequestId } }),
    ).toEqual([
      expect.objectContaining({
        reason: "cancel_review",
        releasedAt: null,
        actorId: p.actor.staff!.staff.id,
      }),
    ]);
    await expect(h.requests.create(p.actor, p.out.orderId, input)).rejects.toMatchObject({
      error: "ORDER_IN_AFTER_SALE",
    });
  });

  it("真实广告位计划阶段经公开取消申请与撤回恢复，父指针及三个时限一致且不动资金", async () => {
    const p = await pending("plan_confirm");
    if (!p.b.term) throw new Error("该真实订购必须已有订阅周期");
    const ad = await h.unassignedAd({
      entity: p.b.entity,
      store: p.b.store,
      user: p.b.user,
      b: { term: p.b.term },
    });
    const placement = await h.prisma.orderItemPlacement.create({
      data: {
        id: uuidv7(),
        orderItemId: p.items[0]!.id,
        slot: "opening",
        adId: ad.id,
        durationSec: 3,
        boundVersionNo: null,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({
        where: { orderItemId: p.items[0]!.id },
      }),
      stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
        where: { deliveryTicketId: ticket.id, completedAt: null },
      }),
      plan = await h.prisma.deliveryPlan.findUniqueOrThrow({
        where: { dramaOrderId: p.out.orderId },
      });
    expect(ticket).toMatchObject({ step: "plan_confirm", waitingOn: "staff", pauseCount: 0 });
    expect(stage.dueAt).not.toBeNull();
    expect(ticket.stepDueAt).toEqual(stage.dueAt);
    expect(plan.staffDueAt).toEqual(stage.dueAt);
    const money = await snapshotTables(h.prisma, MONEY_TABLES),
      quote = await h.requests.quote(p.actor, p.out.orderId, p.input),
      created = await h.requests.create(p.actor, p.out.orderId, {
        ...p.input,
        note: "带真实广告位的计划阶段取消",
        expect: quote.expect,
      }),
      saved = await h.saved(created.cancelRequestId),
      paused = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(paused).toMatchObject({
      step: "plan_confirm",
      waitingOn: "staff",
      pauseCount: 1,
      pauseRemainingMin: expect.any(Number),
    });
    expect(
      await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: p.out.orderId } }),
    ).toMatchObject({ status: "after_sale", openCancelRequestId: saved.id });
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    h.clock.advance(60 * 60_000);
    const expected = await h.tx.run(async (tx) =>
      h.core.sla.dueAt(tx, {
        policy: "ticket.plan_confirm",
        amount: paused.pauseRemainingMin!,
        unit: "work_minutes",
        from: h.clock.now(),
        workHours: await workHoursAt(tx, h.clock.now()),
      }),
    );
    await h.requests.withdraw(p.actor, saved.id, { note: "本人撤回带广告位的取消申请" });
    expect(await h.saved(saved.id)).toMatchObject({
      status: "not_executed",
      closeReason: "withdrawn",
      approvalRequest: { status: "withdrawn" },
    });
    expect(
      await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: p.out.orderId } }),
    ).toMatchObject({ status: "producing", openCancelRequestId: null });
    expect(
      await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
    ).toMatchObject({
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
    expect(await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject(
      { staffDueAt: expected.dueAt },
    );
    expect(
      await h.prisma.deliveryTicketPause.findFirstOrThrow({
        where: { deliveryTicketId: ticket.id, refId: saved.approvalRequestId },
      }),
    ).toMatchObject({ releasedAt: h.clock.now(), releaseEvent: "withdrawn" });
    expect(
      await h.prisma.orderItemPlacement.findUniqueOrThrow({ where: { id: placement.id } }),
    ).toEqual(placement);
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
  });

  it("真实审批守卫自批、版本、确认与再验证；通过只到待执行并登记时限", async () => {
    const p = await pending("plan_confirm");
    const result = await h.create(p);
    const id = result.cancelRequestId;
    const other = await h.staff();
    const body = await h.approveBody(id);
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    await expect(h.requests.approve(p.actor, id, body)).rejects.toMatchObject({
      error: "APPROVAL_SELF_FORBIDDEN",
    });
    await expect(h.requests.approve(noStepUp(other), id, body)).rejects.toMatchObject({
      error: "STEP_UP_REQUIRED",
    });
    await expect(
      h.requests.approve(other, id, { ...body, lockVersion: body.lockVersion + 1 }),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
    await expect(
      h.requests.approve(other, id, {
        ...body,
        confirm: { ...body.confirm, totalRefundPoints: body.confirm.totalRefundPoints + 1 },
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    const money = await snapshotTables(h.prisma, MONEY_TABLES);
    expect(await h.requests.approve(other, id, body)).toMatchObject({
      status: "pending_execution",
      executedAt: null,
    });
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    const saved = await h.saved(id);
    expect(saved).toMatchObject({
      status: "pending_execution",
      executedAt: null,
      recheckLog: { approve: { ok: true } },
      approvalRequest: {
        status: "approved",
        decidedByStaffId: other.staff!.staff.id,
        confirmChecks: ["stage_rule_amount_checked"],
      },
    });
    expect(saved.execDueAt).not.toBeNull();
    expect(
      await h.prisma.timer.findFirst({
        where: {
          subjectId: saved.approvalRequestId,
          dedupeKey: { endsWith: ":execution" },
          status: "scheduled",
        },
      }),
    ).not.toBeNull();
    expect(
      await h.prisma.deliveryTicketPause.count({
        where: { refId: saved.approvalRequestId, releasedAt: null },
      }),
    ).toBe(1);
  });

  it.each(["reject", "withdraw", "void"] as const)(
    "%s 关闭后只解本申请cancel_review，保留其他暂停原因",
    async (action) => {
      const p = await pending("plan_confirm");
      const result = await h.create(p);
      const saved = await h.saved(result.cancelRequestId);
      const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({
        where: { orderItemId: p.items[0]!.id },
      });
      // Another owner's active source is a precondition; the cancellation producer itself is real.
      const foreign = await h.prisma.deliveryTicketPause.create({
        data: {
          id: uuidv7(),
          deliveryTicketId: ticket.id,
          reason: "plan_amendment",
          refType: "delivery_plan_version",
          refId: uuidv7(),
          actorType: "system",
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      await h.prisma.deliveryTicket.update({
        where: { id: ticket.id },
        data: { pauseCount: { increment: 1 } },
      });
      const approver = await h.staff();
      if (action === "void")
        await h.requests.approve(approver, saved.id, await h.approveBody(saved.id));
      const money = await snapshotTables(h.prisma, MONEY_TABLES);
      if (action === "reject")
        await h.requests.reject(noStepUp(approver), saved.id, { note: "成本依据需要重新核实" });
      if (action === "withdraw")
        await h.requests.withdraw(noStepUp(p.actor), saved.id, { note: "本人撤回重新核实" });
      if (action === "void") await h.requests.void(p.actor, saved.id, { note: "执行前由本人作废" });
      assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
      expect(
        await h.prisma.deliveryTicketPause.findUniqueOrThrow({ where: { id: foreign.id } }),
      ).toMatchObject({ releasedAt: null });
      expect(
        await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
      ).toMatchObject({ pauseCount: 1, pausedAt: ticket.pausedAt });
      expect(
        await h.prisma.deliveryTicketPause.findFirstOrThrow({
          where: { refId: saved.approvalRequestId },
        }),
      ).toMatchObject({
        releaseEvent:
          action === "reject" ? "rejected" : action === "withdraw" ? "withdrawn" : "voided",
        releasedAt: h.clock.now(),
      });
      expect(
        await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: p.out.orderId } }),
      ).toMatchObject({ openCancelRequestId: null, status: "producing" });
    },
  );

  it("撤回清父指针并恢复待开工；其他在职员工不可代撤，停用发起人后财务可代撤", async () => {
    const p = await pending();
    const created = await h.create(p);
    const other = await h.staff();
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    await expect(
      h.requests.withdraw(other, created.cancelRequestId, { note: "尝试代撤" }),
    ).rejects.toMatchObject({ error: "APPROVAL_WITHDRAW_FORBIDDEN" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    await h.prisma.staff.update({
      where: { id: p.actor.staff!.staff.id },
      data: { status: "disabled", disabledReason: "other", disabledAt: h.clock.now() },
    });
    await expect(
      h.requests.withdraw(noStepUp(other), created.cancelRequestId, { note: "停用员工代撤" }),
    ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
    await h.requests.withdraw(other, created.cancelRequestId, { note: "停用发起人由财务代撤" });
    expect(
      await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: p.out.orderId } }),
    ).toMatchObject({ status: "pending_start", openCancelRequestId: null });
    expect(await h.tx.run((tx) => startOrder(tx, h.deps, p.out.orderId))).toBe("fired");
    expect(
      await h.prisma.orderItem.findUniqueOrThrow({ where: { id: p.items[0]!.id } }),
    ).toMatchObject({ phase: "producing" });
  });

  it("有效对象不能从系统对象失效事务入口撤回或作废，拒绝后完整快照不变", async () => {
    const p = await pending();
    const created = await h.create(p);
    const id = created.cancelRequestId;
    const system: CancelActor = {
      ctx: createIdentityContext({ actor: { type: "system", job: "order.target_invalid" } }),
    };
    const pendingBefore = await snapshotTables(h.prisma, REQUEST_TABLES);
    await expect(
      h.tx.run((tx) =>
        withdrawCancelRequest(tx, h.requestDeps, system, id, {
          note: "有效对象不能系统撤回",
        }),
      ),
    ).rejects.toMatchObject({ error: "APPROVAL_WITHDRAW_FORBIDDEN" });
    assertSnapshotsEqual(pendingBefore, await snapshotTables(h.prisma, REQUEST_TABLES));
    await h.requests.approve(await h.staff(), id, await h.approveBody(id));
    const approvedBefore = await snapshotTables(h.prisma, REQUEST_TABLES);
    await expect(
      h.tx.run((tx) =>
        voidCancelRequest(tx, h.requestDeps, system, id, {
          note: "有效对象不能系统作废",
        }),
      ),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    assertSnapshotsEqual(approvedBefore, await snapshotTables(h.prisma, REQUEST_TABLES));
  });

  it("作废仅本人且只在批准后，非本人及错误状态不改资金或申请", async () => {
    const p = await pending();
    const created = await h.create(p);
    const id = created.cancelRequestId;
    const other = await h.staff();
    await expect(h.requests.void(p.actor, id, { note: "尚未通过的取消" })).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    await h.requests.approve(other, id, await h.approveBody(id));
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    await expect(h.requests.void(other, id, { note: "他人不能作废" })).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    await h.requests.void(p.actor, id, { note: "发起人撤销执行意愿" });
    expect(await h.saved(id)).toMatchObject({
      status: "not_executed",
      closeReason: "voided",
      approvalRequest: { status: "approved" },
    });
  });

  it("免审批全release同TX调用唯一执行，真实余额/历史/事件只写一次，开工无竞争窗口", async () => {
    const p = await pending();
    await h.param("refund.points.auto_approve_before_production", true, p.actor);
    const q = await h.requests.quote(p.actor, p.out.orderId, p.input);
    expect(
      q.lines.every(
        (line) => line.mode === "release" && line.preview.backToOriginal === line.refundPoints,
      ),
    ).toBe(true);
    const before = await h.prisma.billingAccount.findUniqueOrThrow({
      where: { entityId: p.b.entity.id },
    });
    const input = { ...p.input, note: "开工前全额取消订购", expect: q.expect };
    const key = uuidv7();
    const result = await h.requests.create(
      p.actor,
      p.out.orderId,
      input,
      h.idem(p.actor, input, key),
    );
    expect(result).toMatchObject({ status: "done" });
    const r = await h.saved(result.cancelRequestId);
    expect(r).toMatchObject({
      isExecutedBySystem: true,
      executedByStaffId: null,
      approvalRequest: { status: "approved", isDecidedBySystem: true },
      cancelRequestLines: [
        expect.objectContaining({ mode: "release", returnedPoints: q.totalRefundPoints }),
      ],
    });
    expect(
      await h.prisma.pointHold.findUniqueOrThrow({ where: { id: p.items[0]!.pointHoldId } }),
    ).toMatchObject({ status: "released" });
    expect(
      await h.prisma.orderItem.findUniqueOrThrow({ where: { id: p.items[0]!.id } }),
    ).toMatchObject({ phase: "cancelled" });
    const balance = await h.prisma.billingAccount.findUniqueOrThrow({
      where: { entityId: p.b.entity.id },
    });
    expect(
      balance.planAvailableQty +
        balance.addonAvailableQty -
        before.planAvailableQty -
        before.addonAvailableQty,
    ).toBe(q.totalRefundPoints);
    for (const [aggregateId, eventType] of [
      [r.id, "cancel.executed"],
      [r.approvalRequestId, "approval.executed"],
      [p.out.orderId, "order.status_changed"],
      [p.items[0]!.id, "order.item.cancelled"],
    ])
      expect(await h.prisma.outboxEvent.count({ where: { aggregateId, eventType } })).toBe(1);
    expect(
      await h.prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: p.items[0]!.id, eventType: "order.item.cancelled" },
      }),
    ).toMatchObject({
      payload: expect.objectContaining({
        orderItemId: p.items[0]!.id,
        returnedPoints: q.totalRefundPoints,
        convertedPoints: 0,
        forfeitedPoints: 0,
      }),
    });
    const after = await snapshotTables(h.prisma, REQUEST_TABLES);
    expect(
      await h.requests.create(p.actor, p.out.orderId, input, h.idem(p.actor, input, key)),
    ).toEqual(result);
    expect(await h.tx.run((tx) => startOrder(tx, h.deps, p.out.orderId))).toBe("skipped");
    assertSnapshotsEqual(after, await snapshotTables(h.prisma, REQUEST_TABLES));
    await h.param("refund.points.auto_approve_before_production", false, p.actor);
  });

  it("免审批真实退回与状态写后故障，申请/审批/父指针/资金/历史整体回滚", async () => {
    const p = await pending();
    await h.param("refund.points.auto_approve_before_production", true, p.actor);
    const q = await h.requests.quote(p.actor, p.out.orderId, p.input);
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    let written = false;
    const flow = {
      ...h.requestDeps.flow,
      transition: async (...args: Parameters<typeof h.requestDeps.flow.transition>) => {
        const result = await h.requestDeps.flow.transition(...args);
        if (args[2].machine === "cancel_request" && args[2].event === "cancel.auto_execute") {
          const released = await args[0].pointHold.findUniqueOrThrow({
            where: { id: p.items[0]!.pointHoldId },
          });
          expect(released.status).toBe("released");
          written = true;
          throw new Error("after-real-auto-execute");
        }
        return result;
      },
    };
    const failing = createCancelRequests({ ...h.requestDeps, flow });
    await expect(
      failing.create(p.actor, p.out.orderId, {
        ...p.input,
        note: "免审批同事务失败注入",
        expect: q.expect,
      }),
    ).rejects.toThrow("after-real-auto-execute");
    expect(written).toBe(true);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    await h.param("refund.points.auto_approve_before_production", false, p.actor);
  });

  it("开关开启仍不跳过实际已开工退款审批", async () => {
    const p = await pending("plan_confirm");
    await h.param("refund.points.auto_approve_before_production", true, p.actor);
    const money = await snapshotTables(h.prisma, MONEY_TABLES);
    const r = await h.create(p);
    expect(r).toMatchObject({ status: "pending_approval" });
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    await h.param("refund.points.auto_approve_before_production", false, p.actor);
  });
});
