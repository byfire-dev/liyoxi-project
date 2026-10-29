// W5-01 admin.cancelRequest.execute: production auth/idempotency/stepup and actual DB execution.
import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { CancelRequestDetailSchema } from "@liyoxi/contract";
import { prepareW501AdCancel, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const testApi = useTestApi();
let api: TestApi,
  requester: SignedInStaff,
  approver: SignedInStaff,
  executor: SignedInStaff,
  outsider: SignedInStaff,
  denied: SignedInStaff;
let peer = 0;
const tables = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
  "cancel_request",
  "cancel_request_line",
  "ad",
  "status_transition",
  "audit_log",
  "outbox_event",
];
beforeAll(async () => {
  api = await testApi.start();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  const prisma = await testApi.db.prisma();
  requester = await signInAsStaff(prisma, { roleKey: "super_admin" });
  approver = await signInAsStaff(prisma, { roleKey: "super_admin" });
  executor = await signInAsStaff(prisma, { roleKey: "super_admin" });
  outsider = await signInAsStaff(prisma, { roleKey: "finance" });
  denied = await signInAsStaff(prisma, { roleKey: "editor" });
}, 180000);
const fixture = (captured = false) =>
  testApi.db.prisma().then((prisma) =>
    prepareW501AdCancel(prisma, api.runtime, api.clock, {
      requesterId: requester.staff.id,
      approverId: approver.staff.id,
      captured,
    }),
  );
const post = (id: string, json: unknown, who = executor, key: string | null = uuidv7()) =>
  api.request(`/api/v1/admin/cancel-requests/${id}/execute`, {
    method: "POST",
    json,
    headers: { ...who.headers, ...(key ? { "Idempotency-Key": key } : {}) },
    peer: `198.19.51.${++peer % 250}`,
  });
const data = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
};
const bodyOf = (f: Awaited<ReturnType<typeof fixture>>) => ({
  confirm: f.confirm,
  confirmChecks: ["order_points_checked"],
});
describe("admin.cancelRequest.execute", { timeout: 120000 }, () => {
  it.each([false, true])(
    "真实held/captured=%s执行返回typed详情，原key重放无第二笔账与历史事件",
    async (captured) => {
      const f = await fixture(captured),
        key = uuidv7(),
        prisma = await testApi.db.prisma();
      const response = await post(f.request.id, bodyOf(f), executor, key),
        first = CancelRequestDetailSchema.parse(await data(response));
      expect(first).toMatchObject({ cancelRequestId: f.request.id, status: "done" });
      const saved = await prisma.cancelRequest.findUniqueOrThrow({
        where: { id: f.request.id },
        include: { cancelRequestLines: true },
      });
      const line = saved.cancelRequestLines[0]!;
      if (
        line.returnedPoints === null ||
        line.convertedPoints === null ||
        line.forfeitedPoints === null
      )
        throw new Error("executed line lacks actual ledger result");
      expect(line.returnedPoints + line.convertedPoints + line.forfeitedPoints).toBe(
        line.refundPoints,
      );
      expect(await prisma.ad.findUniqueOrThrow({ where: { id: f.ad.id } })).toMatchObject({
        status: "cancelled",
        openCancelRequestId: null,
        refundRequestedPoints: f.confirm.totalRefundPoints,
        returnedPoints: line.returnedPoints,
      });
      expect(
        await prisma.ledgerOperation.count({
          where: { pointHoldId: f.ad.pointHoldId, opType: captured ? "refund" : "release" },
        }),
      ).toBe(1);
      const before = await snapshotTables(prisma, tables);
      const replay = await post(f.request.id, bodyOf(f), executor, key);
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      expect(CancelRequestDetailSchema.parse(await data(replay))).toMatchObject({
        cancelRequestId: f.request.id,
        status: "done",
      });
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect(
        await prisma.statusTransition.count({
          where: { subjectId: f.request.id, event: "cancel.execute" },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: { aggregateId: f.request.id, eventType: "cancel.executed" },
        }),
      ).toBe(1);
    },
  );
  it("缺key、缺check和确认金额不符均拒绝且零额外账", async () => {
    const f = await fixture(),
      prisma = await testApi.db.prisma(),
      before = await snapshotTables(prisma, tables);
    for (const [body, key, error] of [
      [bodyOf(f), null, "IDEMPOTENCY_KEY_REQUIRED"],
      [{ confirm: f.confirm, confirmChecks: [] }, uuidv7(), "VALIDATION_FAILED"],
      [
        {
          ...bodyOf(f),
          confirm: { ...f.confirm, totalRefundPoints: f.confirm.totalRefundPoints + 1 },
        },
        uuidv7(),
        "CONFIRM_MISMATCH",
      ],
    ] as const) {
      const response = await post(f.request.id, body, executor, key);
      expect([400, 409]).toContain(response.status);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(await snapshotTables(prisma, tables)).toEqual(before);
  });
  it("实际权限/范围守卫：无权403、跨范围404且不泄露申请", async () => {
    const f = await fixture(),
      prisma = await testApi.db.prisma();
    await prisma.staffRole.update({ where: { key: "finance" }, data: { dataScope: "own" } });
    const before = await snapshotTables(prisma, tables);
    const forbidden = await post(f.request.id, bodyOf(f), denied);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    const scoped = await post(f.request.id, bodyOf(f), outsider);
    expect(scoped.status).toBe(404);
    expect(await scoped.json()).toMatchObject({ error: "NOT_FOUND" });
    expect(await snapshotTables(prisma, tables)).toEqual(before);
  });
  it("再验证失败后原key可重试；职责分离拒绝审批人且事务无新增", async () => {
    const f = await fixture(),
      prisma = await testApi.db.prisma(),
      key = uuidv7();
    api.clock.advance(600001);
    const before = await snapshotTables(prisma, tables);
    const blocked = await post(f.request.id, bodyOf(f), executor, key);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "STEP_UP_REQUIRED" });
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    await prisma.staffSession.update({
      where: { id: executor.sessionId },
      data: { stepupAt: api.clock.now() },
    });
    await prisma.staffSession.update({
      where: { id: approver.sessionId },
      data: { stepupAt: api.clock.now() },
    });
    expect(
      CancelRequestDetailSchema.parse(
        await data(await post(f.request.id, bodyOf(f), executor, key)),
      ),
    ).toMatchObject({ status: "done" });
    const other = await fixture();
    api.clock.advance(1);
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "refund.require_distinct_executor",
        value: true,
        effectiveAt: api.clock.now(),
        createdAt: api.clock.now(),
        createdByStaffId: executor.staff.id,
        reason: "HTTP职责分离机制",
      },
    });
    const separationBefore = await snapshotTables(prisma, tables),
      rejected = await post(other.request.id, bodyOf(other), approver);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: "REFUND_EXECUTOR_CONFLICT" });
    expect(await snapshotTables(prisma, tables)).toEqual(separationBefore);
    expect(
      CancelRequestDetailSchema.parse(await data(await post(other.request.id, bodyOf(other)))),
    ).toMatchObject({ status: "done" });
  });
  it("复核差异只写允许的证据，修复上游事实后原key重试只退一次", async () => {
    const f = await fixture(),
      prisma = await testApi.db.prisma(),
      key = uuidv7();
    await prisma.ad.update({
      where: { id: f.ad.id },
      data: { openCancelRequestId: null },
    });
    const stableTables = tables.filter((table) => table !== "cancel_request"),
      before = await snapshotTables(prisma, stableTables);
    const failed = await post(f.request.id, bodyOf(f), executor, key);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await snapshotTables(prisma, stableTables)).toEqual(before);
    expect(
      await prisma.cancelRequest.findUniqueOrThrow({ where: { id: f.request.id } }),
    ).toMatchObject({ status: "pending_execution", recheckLog: { execute: { ok: false } } });
    await prisma.ad.update({
      where: { id: f.ad.id },
      data: { openCancelRequestId: f.request.id },
    });
    expect(
      CancelRequestDetailSchema.parse(
        await data(await post(f.request.id, bodyOf(f), executor, key)),
      ),
    ).toMatchObject({ status: "done" });
    expect(
      await prisma.ledgerOperation.count({
        where: { pointHoldId: f.ad.pointHoldId, opType: "release" },
      }),
    ).toBe(1);
  });
  it("同key缓存命中仍检查当前范围，收窄后返回404且无额外账", async () => {
    const prisma = await testApi.db.prisma();
    await prisma.staffRole.update({ where: { key: "finance" }, data: { dataScope: "all" } });
    api.runtime.staffAuth.roles.invalidate();
    const finance = await signInAsStaff(prisma, { roleKey: "finance", now: api.clock.now() }),
      f = await fixture(),
      key = uuidv7();
    expect(
      CancelRequestDetailSchema.parse(
        await data(await post(f.request.id, bodyOf(f), finance, key)),
      ),
    ).toMatchObject({ status: "done" });
    await prisma.staffRole.update({ where: { key: "finance" }, data: { dataScope: "own" } });
    api.runtime.staffAuth.roles.invalidate();
    const before = await snapshotTables(prisma, tables),
      hidden = await post(f.request.id, bodyOf(f), finance, key);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: "NOT_FOUND" });
    expect(await snapshotTables(prisma, tables)).toEqual(before);
  });
});
