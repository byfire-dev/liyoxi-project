import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CancelRequestListQuerySchema } from "@liyoxi/contract";
import { createIdentityContext } from "../kernel/index.js";
import { ownTaskScope } from "../authz/index.js";
import { calendarDate } from "@liyoxi/shared/time";
import {
  assertSnapshotsEqual,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import type { CancelActor } from "./cancel-context.js";
import { REQUEST_TABLES, requestsHarness } from "./__fixtures__/cancel-requests.js";
import type { RequestsHarness } from "./__fixtures__/cancel-requests.js";
import {
  listCancelRequests,
  readCancelRequestDetail,
  summarizeCancelRequests,
} from "./cancel-read.js";
const db = useSeededDatabase("services", { max: 1 });
let h: RequestsHarness;
beforeAll(async () => {
  h = requestsHarness(await db.prisma());
}, 120000);
afterAll(async () => h?.close());
const query = (storeId?: string) =>
  CancelRequestListQuerySchema.parse({ tab: "all", ...(storeId ? { storeId } : {}) });
const noModules = (actor: CancelActor): CancelActor => ({
  ...actor,
  staff: actor.staff
    ? { ...actor.staff, moduleLevels: { ...actor.staff.moduleLevels, order: "n", finance: "n" } }
    : undefined,
});
async function pending() {
  const p = await h.atStage("pending_start");
  await h.param("refund.points.auto_approve_before_production", false, p.actor);
  return { p, r: await h.create(p) };
}
describe("W5-02取消只读投影", { timeout: 120000 }, () => {
  it("真实申请未执行结果为空；本人、异人动作真实，三读口零写且不接受系统全域", async () => {
    const { p, r } = await pending(),
      finance = await h.staff();
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    const own = await h.tx.run((tx) =>
      readCancelRequestDetail(tx, h.requestDeps, p.actor, r.cancelRequestId),
    );
    expect(own).toMatchObject({
      status: "pending_approval",
      resultTotals: null,
      execution: null,
      isOverdue: false,
    });
    expect(own.lines.every((line) => line.result === null)).toBe(true);
    expect(own.actions).toEqual(["withdraw"]);
    expect(own.approval.actions).toEqual(own.actions);
    const other = await h.tx.run((tx) =>
      readCancelRequestDetail(tx, h.requestDeps, finance, r.cancelRequestId),
    );
    expect(other.actions).toEqual(["approve", "reject"]);
    const list = await h.tx.run((tx) =>
      listCancelRequests(tx, h.requestDeps, finance, query(p.b.store.id)),
    );
    const summary = await h.tx.run((tx) =>
      summarizeCancelRequests(tx, h.requestDeps, finance, { storeId: p.b.store.id }),
    );
    expect(list.items.map((row) => row.cancelRequestId)).toEqual([r.cancelRequestId]);
    expect(summary).toMatchObject({
      tabs: { pending_approval: 1, pending_execution: 0, processed: 0 },
      inProgressCount: 1,
      monthReturnedPoints: 0,
    });
    await expect(
      h.tx.run((tx) =>
        readCancelRequestDetail(
          tx,
          h.requestDeps,
          { ctx: createIdentityContext({ actor: { type: "system", job: "lyxtest.read" } }) },
          r.cancelRequestId,
        ),
      ),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
  });
  it("本人也须模块查看；范围外本人可见，有模块的异人仍受own范围约束", async () => {
    const { p, r } = await pending(),
      other = noModules(await h.staff());
    const mine = noModules(p.actor);
    await expect(
      h.tx.run((tx) => listCancelRequests(tx, h.requestDeps, mine, query(p.b.store.id))),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await expect(
      h.tx.run((tx) => summarizeCancelRequests(tx, h.requestDeps, mine, { storeId: p.b.store.id })),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await expect(
      h.tx.run((tx) => readCancelRequestDetail(tx, h.requestDeps, mine, r.cancelRequestId)),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    const requester = {
      ...p.actor,
      staff: { ...p.actor.staff!, scope: ownTaskScope(p.actor.staff!.staff) },
    };
    expect(
      (
        await h.tx.run((tx) =>
          listCancelRequests(tx, h.requestDeps, requester, query(p.b.store.id)),
        )
      ).total,
    ).toBe(1);
    await expect(
      h.tx.run((tx) => readCancelRequestDetail(tx, h.requestDeps, other, r.cancelRequestId)),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    const made = await h.make.staff({ staffRoleKey: "editor" });
    const staff = await sampleStaffContext(h.prisma, made.id);
    const reader: CancelActor = {
      ctx: createIdentityContext({ actor: { type: "staff", id: made.id, client: "admin" } }),
      staff: { ...staff, moduleLevels: { ...staff.moduleLevels, order: "v" } },
    };
    expect(
      (await h.tx.run((tx) => listCancelRequests(tx, h.requestDeps, reader, query(p.b.store.id))))
        .total,
    ).toBe(0);
    await expect(
      h.tx.run((tx) => readCancelRequestDetail(tx, h.requestDeps, reader, r.cancelRequestId)),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
  });
  it("真实批准保留空执行结果，关闭记录完整；旧stepup不隐藏按钮", async () => {
    const { p, r } = await pending(),
      approver = await h.staff();
    await h.requests.approve(approver, r.cancelRequestId, await h.approveBody(r.cancelRequestId));
    const stale = { ...p.actor, staff: { ...p.actor.staff!, stepUpAt: null } };
    const approved = await h.tx.run((tx) =>
      readCancelRequestDetail(tx, h.requestDeps, stale, r.cancelRequestId),
    );
    expect(approved).toMatchObject({
      status: "pending_execution",
      resultTotals: null,
      execution: null,
    });
    expect(approved.actions).toEqual(["void", "execute"]);
    expect(approved.approval.actions).toEqual(approved.actions);
    await h.requests.void(p.actor, r.cancelRequestId, { note: "商家决定继续交付" });
    const closed = await h.tx.run((tx) =>
      readCancelRequestDetail(tx, h.requestDeps, p.actor, r.cancelRequestId),
    );
    expect(closed).toMatchObject({
      status: "not_executed",
      closeReason: "voided",
      execution: null,
      resultTotals: null,
      actions: [],
    });
    expect(closed.timeline.map((row) => row.action)).toEqual(["submitted", "approved", "voided"]);
  });
  it("执行汇总取真实到账且按北京时间月界切换；同日筛选含两端", async () => {
    // atStage's base fixture intentionally resets to Jan 5. Move only after that setup.
    const p = await h.atStage("pending_start");
    h.clock.set(new Date("2026-01-31T15:58:00Z"));
    await h.param("refund.points.auto_approve_before_production", false, p.actor);
    const r = await h.create(p),
      approver = await h.staff();
    expect(calendarDate(new Date(r.submittedAt))).toBe("2026-01-31");
    await h.requests.approve(approver, r.cancelRequestId, await h.approveBody(r.cancelRequestId));
    await h.execute(await h.staff(), {
      id: r.cancelRequestId,
      confirm: { requestNo: r.requestNo, totalRefundPoints: r.totalRefundPoints },
    });
    const result = await h.tx.run((tx) =>
      readCancelRequestDetail(tx, h.requestDeps, p.actor, r.cancelRequestId),
    );
    expect(calendarDate(new Date(result.executedAt!))).toBe("2026-01-31");
    const summary = await h.tx.run((tx) =>
      summarizeCancelRequests(tx, h.requestDeps, p.actor, {
        storeId: p.b.store.id,
        submittedFrom: "2026-01-31",
        submittedTo: "2026-01-31",
      }),
    );
    expect(summary.monthDoneCount).toBe(1);
    expect(summary.monthReturnedPoints).toBe(
      result.resultTotals!.returnedPoints + result.resultTotals!.convertedPoints,
    );
    h.clock.advance(180000);
    expect(calendarDate(h.clock.now())).toBe("2026-02-01");
    expect(
      (
        await h.tx.run((tx) =>
          summarizeCancelRequests(tx, h.requestDeps, p.actor, { storeId: p.b.store.id }),
        )
      ).monthDoneCount,
    ).toBe(0);
  });
});
