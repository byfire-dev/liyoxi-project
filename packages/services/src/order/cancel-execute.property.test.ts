import fc from "fast-check";
import type { CancelExecuteBody } from "@liyoxi/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import {
  assertSnapshotsEqual,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { createAdCancel } from "./ad-cancel.js";
import {
  CANCEL_TABLES,
  ORDER_STAGES,
  cancelHarness,
  readCancelRequest,
} from "./cancel-execute.fixture.js";
import type { CancelFixture, CancelHarness } from "./cancel-execute.fixture.js";
import type { ReturnResult } from "../billing/index.js";
import { quoteOrderCancel } from "./cancel-quote.js";
const db = useSeededDatabase("services", { max: 1 });
let h: CancelHarness;
beforeAll(async () => {
  h = cancelHarness(await db.prisma());
  h.clock.advance(1);
  await h.prisma.billingParam.create({
    data: {
      id: uuidv7(),
      key: "expiredTermRefund",
      value: { merchant: "forfeit", platform: "addon", qualification: "addon" },
      effectiveAt: h.clock.now(),
      changeId: uuidv7(),
      createdAt: h.clock.now(),
    },
  });
}, 120000);
afterAll(async () => h?.close());

async function execute(p: CancelFixture) {
  const approver = await h.staff(),
    executor = await h.staff();
  const r = await h.request(p, p.quote, p.actor, approver);
  const actual: ReturnResult[] = [];
  const balance = await h.prisma.billingAccount.findUniqueOrThrow({
    where: { entityId: p.b.entity.id },
  });
  const operationsBefore = await h.prisma.ledgerOperation.count({
    where: { entityId: p.b.entity.id },
  });
  const ledger = {
    ...h.ledger,
    release: async (...args: Parameters<typeof h.ledger.release>) => {
      const result = await h.ledger.release(...args);
      actual.push(result);
      return result;
    },
    refund: async (...args: Parameters<typeof h.ledger.refund>) => {
      const result = await h.ledger.refund(...args);
      actual.push(result);
      return result;
    },
  };
  expect(await h.execute(executor, r, { ledger })).toMatchObject({ status: "done" });
  const saved = await h.tx.run((tx) => readCancelRequest(tx, r.id));
  const sums = { returnedPoints: 0, convertedPoints: 0, forfeitedPoints: 0 };
  for (const line of saved.cancelRequestLines) {
    const result = actual.shift() ?? { returnedPoints: 0, convertedPoints: 0, forfeitedPoints: 0 };
    expect(line).toMatchObject({
      returnedPoints: result.returnedPoints,
      convertedPoints: result.convertedPoints,
      forfeitedPoints: result.forfeitedPoints,
    });
    expect(line.executedAt).not.toBeNull();
    if (
      line.returnedPoints === null ||
      line.convertedPoints === null ||
      line.forfeitedPoints === null
    )
      throw new Error("executed line lacks actual result");
    expect(line.returnedPoints + line.convertedPoints + line.forfeitedPoints).toBe(
      line.refundPoints,
    );
    expect(line.resultSnapshot).toMatchObject({
      qty: line.refundPoints,
      backToOriginal: result.returnedPoints,
      convertedToAddon: result.convertedPoints,
      forfeited: result.forfeitedPoints,
      lots: [],
    });
    sums.returnedPoints += line.returnedPoints;
    sums.convertedPoints += line.convertedPoints;
    sums.forfeitedPoints += line.forfeitedPoints;
    const item = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: line.targetId } });
    expect(item).toMatchObject({
      refundRequestedPoints: line.refundPoints,
      returnedPoints: line.returnedPoints,
      convertedPoints: line.convertedPoints,
      forfeitedPoints: line.forfeitedPoints,
    });
    expect(line.stage === "live" ? ["live"] : ["cancelled", "refunded", "terminated"]).toContain(
      item.phase,
    );
    const itemEvents = await h.prisma.outboxEvent.findMany({
      where: {
        aggregateId: item.id,
        eventType: { in: ["order.item.cancelled", "order.item.refunded", "order.item.terminated"] },
      },
    });
    if (line.stage === "live") expect(itemEvents).toHaveLength(0);
    else {
      expect(itemEvents).toHaveLength(1);
      expect(itemEvents[0]).toMatchObject({
        eventType: `order.item.${item.phase}`,
        payload: {
          orderItemId: item.id,
          dramaOrderId: item.dramaOrderId,
          cancelRequestId: r.id,
          toState: item.phase,
          ...(item.phase === "terminated"
            ? {}
            : {
                returnedPoints: result.returnedPoints,
                convertedPoints: result.convertedPoints,
                forfeitedPoints: result.forfeitedPoints,
              }),
        },
      });
    }
    const hold = await h.prisma.pointHold.findUniqueOrThrow({ where: { id: line.pointHoldId } });
    expect(hold.returnedQty + hold.forfeitedQty).toBe(line.refundPoints);
    expect(
      await h.prisma.ledgerOperation.count({
        where: { pointHoldId: hold.id, opType: { in: ["release", "refund"] } },
      }),
    ).toBe(line.mode === "terminate_only" ? 0 : 1);
    expect(
      await h.prisma.deliveryTicket.count({
        where: {
          orderItemId: item.id,
          step: { not: line.stage === "live" ? "takedown" : "terminated" },
        },
      }),
    ).toBe(0);
    expect(
      await h.prisma.deliveryTicketPause.count({
        where: { deliveryTicket: { orderItemId: item.id }, releasedAt: null },
      }),
    ).toBe(0);
  }
  expect(actual).toEqual([]);
  expect(sums.returnedPoints + sums.convertedPoints + sums.forfeitedPoints).toBe(
    saved.totalRefundPoints,
  );
  const after = await h.prisma.billingAccount.findUniqueOrThrow({
    where: { entityId: p.b.entity.id },
  });
  const operations = await h.prisma.ledgerOperation.findMany({
    where: { entityId: p.b.entity.id },
    orderBy: { seq: "asc" },
    skip: operationsBefore,
  });
  expect(after.planAvailableQty - balance.planAvailableQty).toBe(
    operations.reduce((n, op) => n + op.planDeltaQty, 0),
  );
  expect(after.addonAvailableQty - balance.addonAvailableQty).toBe(
    operations.reduce((n, op) => n + op.addonDeltaQty, 0),
  );
  expect(
    operations
      .filter((op) => ["release", "refund"].includes(op.opType))
      .reduce((n, op) => n + op.planDeltaQty + op.addonDeltaQty, 0),
  ).toBe(sums.returnedPoints + sums.convertedPoints);
  expect(saved).toMatchObject({
    status: "done",
    executedByStaffId: executor.staff!.staff.id,
    execConfirmChecks: ["order_points_checked"],
  });
  expect(saved.executedAt).toEqual(saved.closedAt);
  expect(
    (await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: p.out.orderId } }))
      .openCancelRequestId,
  ).toBeNull();
  for (const [eventType, aggregateId] of [
    ["cancel.executed", r.id],
    ["approval.executed", r.approvalRequestId],
  ] as const)
    expect(await h.prisma.outboxEvent.count({ where: { aggregateId, eventType } })).toBe(1);
  expect(
    await h.prisma.statusTransition.count({ where: { subjectId: r.id, event: "cancel.execute" } }),
  ).toBe(1);
  const beforeReplay = await snapshotTables(h.prisma, CANCEL_TABLES);
  await h.execute(executor, r);
  assertSnapshotsEqual(beforeReplay, await snapshotTables(h.prisma, CANCEL_TABLES));
  return { r, saved, sums };
}

describe("取消执行的真实六阶段与账本恒等式", { timeout: 180000 }, () => {
  it.each(ORDER_STAGES)("%s：真实公共履约前置后的平台取消读取实际ReturnResult", async (stage) => {
    const p = await h.atStage(stage, "platform_fault");
    expect(p.quote.lines[0]!.stage).toBe(stage);
    const { saved } = await execute(p);
    expect(saved.cancelRequestLines[0]!.mode).toBe(
      stage === "pending_start" ? "release" : "refund",
    );
    if (stage !== "live") expect(saved.totalRefundPoints).toBe(p.items[0]!.chargePoints);
    if (stage === "live") {
      expect(
        await h.prisma.downloadGrant.count({
          where: { deliveryRelease: { orderItemId: p.items[0]!.id }, state: "active" },
        }),
      ).toBe(0);
      expect(
        await h.prisma.deliveryRelease.count({
          where: { orderItemId: p.items[0]!.id, state: "pushed" },
        }),
      ).toBe(0);
      expect(
        await h.prisma.orderItem.findUniqueOrThrow({ where: { id: p.items[0]!.id } }),
      ).toMatchObject({
        phase: "live",
        usageEndSource: "early_end",
        usageEndDate: saved.cancelRequestLines[0]!.terminationDate,
      });
      expect(
        await h.prisma.launchTask.findFirstOrThrow({ where: { orderItemId: p.items[0]!.id } }),
      ).toMatchObject({ isLive: true, reviewStatus: "passed" });
      expect(
        await h.prisma.takedownTask.findFirstOrThrow({ where: { orderItemId: p.items[0]!.id } }),
      ).toMatchObject({
        status: "pending_merchant",
        triggerKind: "platform_termination",
        dueDate: new Date("2026-01-06"),
      });
      expect(
        await h.prisma.patrolTask.count({
          where: { orderItemId: p.items[0]!.id, status: { in: ["pending", "abnormal"] } },
        }),
      ).toBe(0);
    }
  });
  it.each(ORDER_STAGES.filter((s) => s !== "live"))(
    "%s：商家原因按原始扣费快照执行",
    async (stage) => {
      const p = await h.atStage(stage, "merchant_request");
      const { saved } = await execute(p);
      expect(saved.totalRefundPoints + saved.totalDeductPoints).toBe(saved.totalBasePoints);
      expect(saved.cancelRequestLines[0]!.deductPoints).toBe(p.quote.lines[0]!.deductPoints);
    },
  );
  it.each([
    ["merchant_request", "forfeitedPoints"],
    ["platform_fault", "convertedPoints"],
  ] as const)("过期套餐 %s 实际去向为 %s", async (reason, field) => {
    const p = await h.atStage("pending_start", reason);
    h.clock.set(new Date(p.b.term!.endsAt.getTime() + 1));
    p.actor = {
      ...p.actor,
      staff: await sampleStaffContext(h.prisma, p.actor.staff!.staff.id, {
        stepUpAt: h.clock.now(),
      }),
    };
    p.quote = await h.tx.run((tx) =>
      quoteOrderCancel(
        tx,
        { scope: p.actor.staff!.scope, orderId: p.out.orderId, body: p.input },
        h.clock.now(),
      ),
    );
    const { saved, sums } = await execute(p);
    expect(sums[field]).toBe(saved.totalRefundPoints);
    expect(sums.returnedPoints).toBe(0);
  });
  it("显式全扣的terminate_only不产生零额伪退款", async () => {
    const p = await h.atStage("post_sample");
    p.input.manualDeducts![0]!.deductPoints = p.items[0]!.chargePoints;
    p.quote = await h.tx.run((tx) =>
      quoteOrderCancel(
        tx,
        { scope: p.actor.staff!.scope, orderId: p.out.orderId, body: p.input },
        h.clock.now(),
      ),
    );
    expect(p.quote.lines[0]).toMatchObject({ mode: "terminate_only", refundPoints: 0 });
    await execute(p);
  });
  it("同一幂等键重放保原结果且资金、历史、审计与事件不增长", async () => {
    const p = await h.atStage("pending_start"),
      r = await h.request(p, p.quote, p.actor, await h.staff()),
      executor = await h.staff();
    const body: CancelExecuteBody = { confirm: r.confirm, confirmChecks: ["order_points_checked"] };
    const key = uuidv7();
    const idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.cancelRequest.execute",
        actor: executor.ctx.actor,
        key,
        request: { method: "POST", body },
      });
    const service = createAdCancel(h.cancelDeps);
    const first = await service.execute(executor, r.id, body, idem());
    const before = await snapshotTables(h.prisma, CANCEL_TABLES);
    const replay = idem();
    expect(await service.execute(executor, r.id, body, replay)).toMatchObject({
      id: first.id,
      status: "done",
    });
    expect(replay.replayed).toBe(true);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, CANCEL_TABLES));
  });
  const seed = Number(process.env.LYX_FC_SEED ?? 20261030),
    numRuns = Number(process.env.LYX_FC_RUNS ?? 10);
  it(`性质：随机1–3明细与商家/平台原因 seed=${seed} runs=${numRuns}`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom("merchant_request" as const, "platform_fault" as const),
        async (count, reason) => {
          await execute(await h.atStage("pending_start", reason, count));
        },
      ),
      { seed, numRuns, endOnFailure: true },
    );
  });
});
