import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase, releaseHold, captureHold } from "../testing/index.js";
import { startOrder, startOrderUseCase } from "./start.js";
import { startHarness, startSnapshot, pendingCancel } from "./__fixtures__/start-harness.js";
import type { StartHarness } from "./__fixtures__/start-harness.js";
const db = useSeededDatabase("services");
let h: StartHarness;
beforeAll(async () => {
  h = startHarness(await db.prisma());
}, 120000);
afterAll(() => h?.clear());
describe("开工同事务真实扣减与工单", { timeout: 120000 }, () => {
  it("两部剧各扣一次，captured_at/phase同迁移；父单与真实工单同一时点，重复零写", async () => {
    const manager = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      p = await h.pending({ count: 2, managerId: manager.id });
    const at = h.clock.now();
    expect(await startOrderUseCase(h.deps, p.id)).toBe("fired");
    const order = await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: p.id } });
    expect(order).toMatchObject({ status: "producing", startedAt: at, subStatus: "plan_confirm" });
    const items = await h.prisma.orderItem.findMany({ where: { dramaOrderId: p.id } });
    expect(
      items.every((i) => i.phase === "producing" && i.capturedAt?.getTime() === at.getTime()),
    ).toBe(true);
    for (const item of items) {
      expect(
        await h.prisma.ledgerOperation.count({
          where: { opKey: `capture:point_hold:${item.pointHoldId}` },
        }),
      ).toBe(1);
      expect(
        await h.prisma.statusTransition.count({
          where: { subjectId: item.id, event: "order.start" },
        }),
      ).toBe(1);
    }
    const tickets = await h.prisma.deliveryTicket.findMany({ where: { dramaOrderId: p.id } });
    expect(tickets).toHaveLength(2);
    expect(
      tickets.every(
        (t) =>
          t.step === "plan_confirm" &&
          t.deliveryManagerId === manager.id &&
          t.createdAt.getTime() === at.getTime(),
      ),
    ).toBe(true);
    expect(await h.prisma.deliveryPlan.count({ where: { dramaOrderId: p.id } })).toBe(1);
    const events = await h.prisma.outboxEvent.findMany({
      where: { eventType: "order.started", aggregateId: p.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      orderItemIds: expect.arrayContaining(items.map((i) => i.id)),
      deliveryTicketIds: expect.arrayContaining(tickets.map((t) => t.id)),
      fromState: "pending_start",
      toState: "producing",
      transition: "order.start",
    });
    const before = await startSnapshot(h, p.b.entity.id);
    expect(await startOrderUseCase(h.deps, p.id)).toBe("skipped");
    expect(await startSnapshot(h, p.b.entity.id)).toEqual(before);
  });
  it("池为空停assigning；两池UUID反序仍真分配经理/发布员，并同步同店未结单", async () => {
    await h.prisma.assignmentPoolMember.deleteMany();
    const empty = await h.pending();
    expect(await startOrderUseCase(h.deps, empty.id)).toBe("fired");
    expect(
      await h.prisma.deliveryTicket.findFirst({ where: { dramaOrderId: empty.id } }),
    ).toMatchObject({ step: "assigning", deliveryManagerId: null, publisherId: null });
    const publisher = await h.pool("publisher", "019b8726-0000-7000-8000-000000000001"),
      manager = await h.pool("delivery_manager", "019b8726-0000-7000-8000-000000000002");
    expect(publisher.id < manager.id).toBe(true);
    const p = await h.pending();
    const sibling = await h.make.dramaOrder({
      entityId: p.b.entity.id,
      storeId: p.b.store.id,
      subscriptionTermId: p.b.term!.id,
    });
    expect(await startOrderUseCase(h.deps, p.id)).toBe("fired");
    expect(await h.prisma.store.findUnique({ where: { id: p.b.store.id } })).toMatchObject({
      deliveryManagerId: manager.id,
    });
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: sibling.id } })).toMatchObject({
      deliveryManagerId: manager.id,
    });
    expect(
      await h.prisma.deliveryTicket.findFirst({ where: { dramaOrderId: p.id } }),
    ).toMatchObject({
      step: "plan_confirm",
      deliveryManagerId: manager.id,
      publisherId: publisher.id,
    });
  });
  it("非待开工、在途取消、闸门非full均skipped，业务零写", async () => {
    const parallel = await h.pending({ gate: "parallel" });
    const cancelled = await h.pending();
    await pendingCancel(h, cancelled);
    for (const p of [parallel, cancelled]) {
      const before = await startSnapshot(h, p.b.entity.id);
      expect(await h.tx.run((tx) => startOrder(tx, h.deps, p.id))).toBe("skipped");
      expect(await startSnapshot(h, p.b.entity.id)).toEqual(before);
    }
  });
  it("第二部冻结已释放：整单与经理指派回滚，告警一次；套餐等待期到期不阻挡", async () => {
    const p = await h.pending({ count: 2 });
    await releaseHold(h, p.items[1]!.pointHoldId);
    const before = await startSnapshot(h, p.b.entity.id),
      alerts = h.alerts.length;
    await expect(startOrderUseCase(h.deps, p.id)).rejects.toMatchObject({ reason: "not_held" });
    expect(await startSnapshot(h, p.b.entity.id)).toEqual(before);
    expect(h.alerts.slice(alerts)).toHaveLength(1);
    expect(await h.prisma.store.findUnique({ where: { id: p.b.store.id } })).toMatchObject({
      deliveryManagerId: null,
    });
    const expired = await h.pending();
    h.clock.set(new Date(expired.b.term!.endsAt.getTime() + 1));
    expect(await startOrderUseCase(h.deps, expired.id)).toBe("fired");
  });
  it("待开工却已有孤立扣减也拒绝，不把账本重放当作合法开工", async () => {
    const p = await h.pending();
    await captureHold(h, p.items[0]!.pointHoldId);
    const before = await startSnapshot(h, p.b.entity.id),
      alerts = h.alerts.length;
    await expect(startOrderUseCase(h.deps, p.id)).rejects.toMatchObject({
      reason: "not_held",
      status: "captured",
    });
    expect(await startSnapshot(h, p.b.entity.id)).toEqual(before);
    expect(h.alerts.slice(alerts)).toHaveLength(1);
  });
});
