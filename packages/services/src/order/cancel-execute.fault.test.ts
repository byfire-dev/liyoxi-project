import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../kernel/index.js";
import { uuidv7 } from "../kernel/index.js";
import { assertSnapshotsEqual, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { createAdCancel } from "./ad-cancel.js";
import { CANCEL_TABLES, cancelHarness, readCancelRequest } from "./cancel-execute.fixture.js";
import type { CancelHarness } from "./cancel-execute.fixture.js";
const db = useSeededDatabase("services", { max: 1 });
let h: CancelHarness;
beforeAll(async () => {
  h = cancelHarness(await db.prisma());
}, 120000);
afterAll(async () => h?.close());
async function ready(stage: "pending_start" | "plan_confirm" = "pending_start") {
  const p = await h.atStage(stage),
    approver = await h.staff(),
    executor = await h.staff();
  const r = await h.request(p, p.quote, p.actor, approver);
  return { p, r, executor, approver };
}
describe("取消执行故障与事务边界", { timeout: 120000 }, () => {
  it("approval.recordExecuted只接受已真实执行且同员工的取消关联，不能提前发成功事件", async () => {
    const f = await ready(),
      before = await snapshotTables(h.prisma, CANCEL_TABLES);
    const record = (actor = f.executor, domainId = f.r.id) =>
      h.tx.run((tx) =>
        h.cancelDeps.approval.recordExecuted(tx, actor.ctx, {
          approvalId: f.r.approvalRequestId,
          domain: { type: "cancel_request", id: domainId },
        }),
      );
    await expect(record()).rejects.toMatchObject({ name: "ApprovalError", reason: "execution" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, CANCEL_TABLES));
    await h.execute(f.executor, f.r);
    const done = await snapshotTables(h.prisma, CANCEL_TABLES);
    await expect(record(f.executor, uuidv7())).rejects.toMatchObject({
      name: "ApprovalError",
      reason: "execution",
    });
    await expect(record(await h.staff())).rejects.toMatchObject({
      name: "ApprovalError",
      reason: "execution",
    });
    assertSnapshotsEqual(done, await snapshotTables(h.prisma, CANCEL_TABLES));
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: f.r.approvalRequestId, eventType: "approval.executed" },
      }),
    ).toBe(1);
  });
  it.each(["pending_start", "plan_confirm"] as const)(
    "%s：真实账本写入后抛错，业务/暂停/历史/审计/资金全部回滚",
    async (stage) => {
      const f = await ready(stage),
        before = await snapshotTables(h.prisma, CANCEL_TABLES);
      let returned = false;
      const ledger = {
        ...h.ledger,
        release: async (...args: Parameters<typeof h.ledger.release>) => {
          await h.ledger.release(...args);
          returned = true;
          throw new Error("after-real-release");
        },
        refund: async (...args: Parameters<typeof h.ledger.refund>) => {
          await h.ledger.refund(...args);
          returned = true;
          throw new Error("after-real-refund");
        },
      };
      await expect(h.execute(f.executor, f.r, { ledger })).rejects.toThrow(
        stage === "pending_start" ? "after-real-release" : "after-real-refund",
      );
      expect(returned).toBe(true);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, CANCEL_TABLES));
      expect(await h.execute(f.executor, f.r)).toMatchObject({ status: "done" });
    },
  );
  it("cancel.executed出站写后故障仍整体回滚，原申请可重试", async () => {
    const f = await ready(),
      before = await snapshotTables(h.prisma, CANCEL_TABLES);
    let emitted = false;
    const events = {
      ...h.events,
      emit: async (...args: Parameters<typeof h.events.emit>) => {
        const result = await h.events.emit(...args);
        if (args[2].type === "cancel.executed") {
          emitted = true;
          throw new Error("after-real-cancel-event");
        }
        return result;
      },
    };
    // The real flow has already written cancellation history, audit and outbox here.
    const flow = {
      ...h.cancelDeps.flow,
      transition: async (...args: Parameters<typeof h.cancelDeps.flow.transition>) => {
        const result = await h.cancelDeps.flow.transition(...args);
        if (args[2].machine === "cancel_request" && args[2].event === "cancel.execute") {
          emitted = true;
          throw new Error("after-real-cancel-event");
        }
        return result;
      },
    };
    await expect(h.execute(f.executor, f.r, { flow, events })).rejects.toThrow(
      "after-real-cancel-event",
    );
    expect(emitted).toBe(true);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, CANCEL_TABLES));
  });
  it("ACCOUNT_BUSY基础设施错误向上传播，不保存误导的复核差异", async () => {
    const f = await ready(),
      before = await snapshotTables(h.prisma, CANCEL_TABLES);
    await expect(
      h.execute(f.executor, f.r, {
        ledger: {
          ...h.ledger,
          lockAccount: async () => {
            throw new AppError("ACCOUNT_BUSY");
          },
        },
      }),
    ).rejects.toMatchObject({ error: "ACCOUNT_BUSY" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, CANCEL_TABLES));
  });
  it("全部明细复核后才执行：第二行变化只留execute差异证据，第一行也不退", async () => {
    const p = await h.atStage("pending_start", "merchant_request", 2),
      executor = await h.staff(),
      r = await h.request(p, p.quote, p.actor, await h.staff());
    await h.tx.run((tx) =>
      h.ledger.release(tx, {
        pointHoldId: p.items[1]!.pointHoldId,
        reasonClass: "merchant",
        title: { refNo: r.confirm.requestNo, dramaTitles: [] },
        ctx: executor.ctx,
      }),
    );
    const tables = CANCEL_TABLES.filter((t) => t !== "cancel_request"),
      before = await snapshotTables(h.prisma, tables);
    const service = createAdCancel(h.cancelDeps);
    await expect(
      service.execute(executor, r.id, {
        confirm: r.confirm,
        confirmChecks: ["order_points_checked"],
      }),
    ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    const saved = await h.tx.run((tx) => readCancelRequest(tx, r.id));
    expect(saved).toMatchObject({
      status: "pending_execution",
      executedAt: null,
      recheckLog: { execute: { ok: false } },
    });
    expect(saved.cancelRequestLines.every((l) => l.executedAt === null)).toBe(true);
  });
  it("职责分离开关以执行时参数为准，拒绝审批人后其他财务可执行", async () => {
    const f = await ready();
    await h.param("refund.require_distinct_executor", true, f.executor);
    const before = await snapshotTables(h.prisma, CANCEL_TABLES);
    await expect(h.execute(f.approver, f.r)).rejects.toMatchObject({
      error: "REFUND_EXECUTOR_CONFLICT",
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, CANCEL_TABLES));
    expect(await h.execute(f.executor, f.r)).toMatchObject({ status: "done" });
    await h.param("refund.require_distinct_executor", false, f.executor);
  });
  it("确认金额变化不能执行，未再验证的上下文不能开始账本操作", async () => {
    const f = await ready(),
      before = await snapshotTables(h.prisma, CANCEL_TABLES);
    await expect(
      h.execute(f.executor, {
        ...f.r,
        confirm: { ...f.r.confirm, totalRefundPoints: f.r.confirm.totalRefundPoints + 1 },
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    await expect(
      h.execute({ ...f.executor, staff: { ...f.executor.staff!, stepUpAt: null } }, f.r),
    ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, CANCEL_TABLES));
  });
});
