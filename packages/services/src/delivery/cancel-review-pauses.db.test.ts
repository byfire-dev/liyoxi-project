import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@liyoxi/db";
import { createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { readCancelReviewPauseTargets, releaseCancelReviewPauses } from "./index.js";
const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.cancel_resume" } });
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
beforeEach(() => h.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(() => h?.unbind());

async function paused(
  step = "sample_making",
  count = 1,
  remaining: number | null = 30,
  posterFileId?: string,
  episodeCount?: number,
) {
  const o = await h.order(true, count, posterFileId, episodeCount);
  const approvalId = uuidv7(),
    now = h.clock.now();
  const snapshot = {
    policy: "ticket.sample_making",
    amount: 2,
    unit: "work_days",
    calendarVersion: 1,
    computedAt: now.toISOString(),
  };
  for (const id of o.deliveryTicketIds) {
    await h.prisma.deliveryTicket.update({
      where: { id },
      data: {
        step,
        pauseCount: 1,
        pausedAt: now,
        pauseRemainingMin: remaining,
        stepDueAt: remaining === null ? null : new Date(now.getTime() + remaining * 60000),
      },
    });
    await h.prisma.deliveryTicketStage.updateMany({
      where: { deliveryTicketId: id, completedAt: null },
      data: {
        step,
        dueAt: remaining === null ? null : new Date(now.getTime() + remaining * 60000),
        slaSnapshot: remaining === null ? Prisma.DbNull : snapshot,
      },
    });
    await cause(id, approvalId);
  }
  return { ...o, approvalId, snapshot };
}
async function cause(id: string, refId: string, reason = "cancel_review") {
  return h.prisma.deliveryTicketPause.create({
    data: {
      id: uuidv7(),
      deliveryTicketId: id,
      reason,
      refType: reason === "cancel_review" ? "approval_request" : "delivery_plan_version",
      refId,
      actorType: "system",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
}
async function release(
  tx: Tx,
  refs: string[],
  event: "rejected" | "withdrawn" | "voided" = "withdrawn",
) {
  return releaseCancelReviewPauses(tx, h.deps, ctx, {
    targets: await readCancelReviewPauseTargets(tx, refs),
    releaseEvent: event,
  });
}
describe("取消审批暂停精确恢复", { timeout: 60000 }, () => {
  it.each(["rejected", "withdrawn", "voided"] as const)(
    "%s 只释放该审批原因，保留其他审批及方案原因",
    async (event) => {
      const o = await paused(),
        id = o.deliveryTicketIds[0]!;
      const other = await cause(id, uuidv7()),
        plan = await cause(id, uuidv7(), "plan_amendment");
      await h.prisma.deliveryTicket.update({ where: { id }, data: { pauseCount: 3 } });
      const before = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } });
      const stageBefore = await h.prisma.deliveryTicketStage.findFirstOrThrow({
        where: { deliveryTicketId: id, completedAt: null },
      });
      const callbacks = h.rederivations.length;
      expect(await h.tx.run((t) => release(t, [o.approvalId], event))).toEqual({
        released: 1,
        resumedTicketIds: [],
      });
      expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({
        pauseCount: 2,
        pausedAt: before.pausedAt,
        pauseRemainingMin: 30,
        stepDueAt: before.stepDueAt,
      });
      expect(
        await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: stageBefore.id } }),
      ).toEqual(stageBefore);
      expect(
        await h.prisma.deliveryTicketPause.findMany({ where: { id: { in: [other.id, plan.id] } } }),
      ).toEqual([
        expect.objectContaining({ releasedAt: null }),
        expect.objectContaining({ releasedAt: null }),
      ]);
      expect(
        await h.prisma.deliveryTicketPause.findFirstOrThrow({ where: { refId: o.approvalId } }),
      ).toMatchObject({ releaseEvent: event, releasedAt: h.clock.now() });
      expect(h.rederivations).toHaveLength(callbacks);
      expect(
        await h.prisma.statusTransition.findFirstOrThrow({
          where: { subjectId: id, event: "ticket.resume" },
        }),
      ).toMatchObject({ fromState: "sample_making", toState: "sample_making" });
      expect(
        await h.prisma.outboxEvent.findFirstOrThrow({
          where: { aggregateId: id, eventType: "ticket.resumed" },
        }),
      ).toMatchObject({
        payload: {
          v: 1,
          deliveryTicketId: id,
          orderItemId: o.items[0]!.id,
          reason: "cancel_review",
          refId: o.approvalId,
          fromState: "sample_making",
          toState: "sample_making",
          transition: "ticket.resume",
        },
      });
      const counts = await h.tx.run((t) => h.counts(t, id));
      expect(await h.tx.run((t) => release(t, [o.approvalId]))).toEqual({
        released: 0,
        resumedTicketIds: [],
      });
      expect(await h.tx.run((t) => h.counts(t, id))).toEqual(counts);
    },
  );
  it("最后原因恢复剩余工作分钟与原策略，计一次暂停并登记真实阶段时钟", async () => {
    const o = await paused(),
      id = o.deliveryTicketIds[0]!;
    const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: id, completedAt: null },
    });
    h.clock.advance(60 * 60000);
    expect(await h.tx.run((t) => release(t, [o.approvalId]))).toEqual({
      released: 1,
      resumedTicketIds: [id],
    });
    const expected = new Date(h.clock.now().getTime() + 30 * 60000);
    const after = await h.prisma.deliveryTicketStage.findUniqueOrThrow({ where: { id: stage.id } });
    expect(after).toMatchObject({
      dueAt: expected,
      pausedMinutes: 60,
      slaSnapshot: {
        ...o.snapshot,
        computedAt: h.clock.now().toISOString(),
        calendarVersion: expect.any(Number),
      },
    });
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({
      pauseCount: 0,
      pausedAt: null,
      pauseRemainingMin: null,
      stepDueAt: expected,
    });
    expect(
      await h.prisma.timer.findMany({ where: { subjectId: stage.id, status: "scheduled" } }),
    ).toEqual([
      expect.objectContaining({
        kind: "sla.breach",
        fireAt: expected,
        dedupeKey: timerKey("sla.breach", { type: "delivery_ticket_stage", id: stage.id }),
        payload: { ...(after.slaSnapshot as object), dueAt: expected.toISOString() },
      }),
    ]);
    expect(
      await h.prisma.timer.count({
        where: { subjectId: id, kind: { in: ["sample.remind", "launch.remind"] } },
      }),
    ).toBe(0);
  });
  it("同一工单两审批一批解除：两次同态历史，暂停分钟只累计一次", async () => {
    const o = await paused(),
      id = o.deliveryTicketIds[0]!,
      second = uuidv7();
    await cause(id, second);
    await h.prisma.deliveryTicket.update({ where: { id }, data: { pauseCount: 2 } });
    h.clock.advance(60 * 60000);
    expect(await h.tx.run((t) => release(t, [second, o.approvalId]))).toEqual({
      released: 2,
      resumedTicketIds: [id],
    });
    expect(
      await h.prisma.statusTransition.count({ where: { subjectId: id, event: "ticket.resume" } }),
    ).toBe(2);
    expect(
      (
        await h.prisma.deliveryTicketStage.findFirstOrThrow({
          where: { deliveryTicketId: id, completedAt: null },
        })
      ).pausedMinutes,
    ).toBe(60);
  });
  it.each([null, 0])("remaining=%s 保真；无时限不造 timer，零分钟立即到期", async (remaining) => {
    const o = await paused("sample_confirm", 1, remaining),
      id = o.deliveryTicketIds[0]!;
    await h.tx.run((t) => release(t, [o.approvalId]));
    const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } });
    const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: id, completedAt: null },
    });
    expect(ticket.stepDueAt).toEqual(remaining === null ? null : h.clock.now());
    expect(
      await h.prisma.timer.count({ where: { subjectId: stage.id, status: "scheduled" } }),
    ).toBe(remaining === null ? 0 : 1);
  });
  it("所有工单先预锁，再求值回调旧父锁；推进后取消旧阶段 timer", async () => {
    const o = await paused("ad_prep", 2),
      ids = [...o.deliveryTicketIds].sort();
    const stageIds = (
      await h.prisma.deliveryTicketStage.findMany({
        where: { deliveryTicketId: { in: ids }, completedAt: null },
      })
    ).map((s) => s.id);
    h.rederiveHook.run = async (tx) => {
      await lockRows(tx, "drama_order", [o.order.id]);
      await lockRows(
        tx,
        "order_item",
        o.items.map((i) => i.id),
      );
      await lockRows(tx, "delivery_ticket", ids);
    };
    try {
      expect(await h.tx.run((t) => release(t, [o.approvalId]))).toEqual({
        released: 2,
        resumedTicketIds: ids,
      });
    } finally {
      delete h.rederiveHook.run;
    }
    expect(
      await h.prisma.deliveryTicket.findMany({
        where: { id: { in: ids } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(
      ids.map((id) => expect.objectContaining({ id, step: "sample_making", pauseCount: 0 })),
    );
    expect(
      await h.prisma.timer.count({ where: { subjectId: { in: stageIds }, status: "scheduled" } }),
    ).toBe(0);
  });
  it("跨订单/方案/封面整体预锁后，真实成片求值和媒体引用不补低序锁", async () => {
    const posters = [await h.make.fileObject(), await h.make.fileObject()];
    const a = await paused("batch_compose", 1, 30, posters[1]!.id, 1);
    const b = await paused("batch_compose", 1, 30, posters[0]!.id, 1);
    const admin = await h.staff(),
      orders = [a, b];
    for (const o of orders) {
      const id = o.deliveryTicketIds[0]!,
        outputId = uuidv7();
      const file = await h.make.fileObject({
        category: "final_episode",
        bucket: "secure",
        scopeType: "store",
        entityId: o.entity.id,
        storeId: o.store.id,
      });
      const base = {
        entityId: o.entity.id,
        storeId: o.store.id,
        deliveryTicketId: id,
        checklistVersionNo: 1,
        results: [],
        verdict: "pass",
        inspectedByStaffId: admin.row.id,
        inspectedAt: h.clock.now(),
        createdAt: h.clock.now(),
      };
      const qc = await h.prisma.qcRecord.create({
        data: {
          ...base,
          id: uuidv7(),
          targetType: "episode_output",
          targetId: outputId,
          checklistCode: "qc.episode",
        },
      });
      await h.prisma.episodeOutput.create({
        data: {
          id: outputId,
          entityId: o.entity.id,
          storeId: o.store.id,
          deliveryTicketId: id,
          episodeNo: 1,
          fileId: file.id,
          sizeBytes: 1024,
          status: "qc_passed",
          isCurrent: true,
          qcRecordId: qc.id,
          uploadedByStaffId: admin.row.id,
          uploadedAt: h.clock.now(),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      await h.prisma.qcRecord.create({
        data: {
          ...base,
          id: uuidv7(),
          targetType: "delivery_ticket",
          targetId: id,
          checklistCode: "qc.package",
        },
      });
    }
    h.rederiveHook.run = async (tx) => {
      await lockRows(
        tx,
        "drama_order",
        orders.map((o) => o.order.id),
      );
      await lockRows(
        tx,
        "order_item",
        orders.flatMap((o) => o.items.map((i) => i.id)),
      );
      await lockRows(
        tx,
        "delivery_ticket",
        orders.flatMap((o) => o.deliveryTicketIds),
      );
      await lockRows(
        tx,
        "delivery_plan",
        orders.map((o) => o.deliveryPlanId),
      );
      await lockRows(
        tx,
        "file_object",
        posters.map((p) => p.id),
      );
    };
    try {
      expect(
        (
          await h.tx.run((t) =>
            release(
              t,
              orders.map((o) => o.approvalId),
            ),
          )
        ).released,
      ).toBe(2);
    } finally {
      delete h.rederiveHook.run;
    }
    const tickets = orders.flatMap((o) => o.deliveryTicketIds);
    const lists = await h.prisma.publishList.findMany({
      where: { deliveryTicketId: { in: tickets } },
    });
    expect(lists).toHaveLength(2);
    expect(
      await h.prisma.fileRef.count({
        where: { refType: "publish_list", refId: { in: lists.map((l) => l.id) }, state: "live" },
      }),
    ).toBe(2);
    expect(
      await h.prisma.deliveryTicket.count({
        where: { id: { in: tickets }, step: "delivering", pauseCount: 0 },
      }),
    ).toBe(2);
  });
  it("求值接收方失败使全部原因、汇总、阶段、timer、历史与接收写入回滚", async () => {
    const o = await paused("ad_prep", 2),
      id = o.deliveryTicketIds[0]!;
    const before = await h.tx.run((t) => h.counts(t, id));
    const timerRows = async () =>
      h.prisma.timer.findMany({
        where: {
          subjectId: {
            in: (
              await h.prisma.deliveryTicketStage.findMany({
                where: { deliveryTicketId: { in: o.deliveryTicketIds } },
              })
            ).map((s) => s.id),
          },
        },
        orderBy: { id: "asc" },
      });
    const beforeTimers = await timerRows();
    h.rederiveHook.run = async (t) => {
      await t.dramaOrder.update({ where: { id: o.order.id }, data: { note: "rolled-back" } });
      throw new Error("receiver failed");
    };
    try {
      await expect(h.tx.run((t) => release(t, [o.approvalId]))).rejects.toThrow("receiver failed");
    } finally {
      delete h.rederiveHook.run;
    }
    expect(
      await h.prisma.deliveryTicketPause.count({
        where: { refId: o.approvalId, releasedAt: null },
      }),
    ).toBe(2);
    expect(
      await h.prisma.deliveryTicket.findMany({
        where: { id: { in: o.deliveryTicketIds } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(
      [...o.deliveryTicketIds]
        .sort()
        .map((id) => expect.objectContaining({ id, pauseCount: 1, step: "ad_prep" })),
    );
    expect(await timerRows()).toEqual(beforeTimers);
    expect(await h.tx.run((t) => h.counts(t, id))).toEqual(before);
    expect((await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: o.order.id } })).note).toBe(
      o.order.note,
    );
  });
  it("预读后目标图扩大及暂停汇总不一致均原子拒绝", async () => {
    const o = await paused(),
      id = o.deliveryTicketIds[0]!;
    const stale = await h.tx.run((t) => readCancelReviewPauseTargets(t, [o.approvalId]));
    const second = await h.order();
    await cause(second.deliveryTicketIds[0]!, o.approvalId);
    await expect(
      h.tx.run((t) =>
        releaseCancelReviewPauses(t, h.deps, ctx, { targets: stale, releaseEvent: "voided" }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await h.prisma.deliveryTicket.update({ where: { id }, data: { pauseCount: 2 } });
    await expect(h.tx.run((t) => release(t, [o.approvalId]))).rejects.toThrow(
      "工单暂停集合与汇总不一致",
    );
    expect(
      await h.prisma.deliveryTicketPause.count({
        where: { refId: o.approvalId, releasedAt: null },
      }),
    ).toBe(2);
  });
  it("原 timer 已无法重新登记时不提交假恢复", async () => {
    const o = await paused(),
      id = o.deliveryTicketIds[0]!;
    const stage = await h.prisma.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: id, completedAt: null },
    });
    const timers = createTimers({ assembly: h.assembly });
    const armed = await h.tx.run(async (t) => {
      await lockRows(t, "delivery_ticket", [id]);
      return timers.arm(t, {
        kind: "sla.breach",
        subject: { type: "delivery_ticket_stage", id: stage.id },
        key: timerKey("sla.breach", { type: "delivery_ticket_stage", id: stage.id }),
        fireAt: stage.dueAt!,
      });
    });
    await h.prisma.timer.update({
      where: { id: armed.id },
      data: { status: "skipped", firedAt: h.clock.now() },
    });
    await expect(h.tx.run((t) => release(t, [o.approvalId]))).rejects.toThrow("恢复环节时限未登记");
    expect((await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).pauseCount).toBe(1);
    expect(
      (await h.prisma.deliveryTicketPause.findFirstOrThrow({ where: { refId: o.approvalId } }))
        .releasedAt,
    ).toBeNull();
  });
});
