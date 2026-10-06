import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  AdminDeliveryPlanWriteResultSchema,
  DeliveryTicketDetailSchema,
  DeliveryTicketWriteResultSchema,
  DeliveryPlanWriteResultSchema,
  TicketListQuerySchema,
} from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { lockRows } from "../kernel/index.js";
import { createTickets, prepareTicketAssignees } from "./create.js";
import { findDeliveryViolations, DELIVERY_INVARIANT_CODES } from "./invariants.js";
import { draft, harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
describe("delivery PR1 真实主链", { timeout: 60000 }, () => {
  it("创建、profile 同事务批量分配、推送、确认到 sample_making，历史审计事件与环节一致", async () => {
    const o = await h.order(false, 2),
      admin = await h.staff(),
      manager = await h.make.staff({ staffRoleKey: "delivery_manager" });
    const result = await h.delivery.assign(admin.ctx, admin.staff, o.deliveryTicketIds[0]!, {
      staffId: manager.id,
    });
    expect(h.rederivations.at(-1)?.steps).toEqual(["plan_confirm", "plan_confirm"]);
    expect(DeliveryTicketWriteResultSchema.parse(result).step).toBe("plan_confirm");
    expect(
      (await h.prisma.store.findUniqueOrThrow({ where: { id: o.store.id } })).deliveryManagerId,
    ).toBe(manager.id);
    for (const id of o.deliveryTicketIds)
      expect(await h.tx.run((t) => h.counts(t, id))).toEqual({ history: 2, events: 2, audit: 2 });
    await h.delivery.replaceDraft(admin.ctx, admin.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: draft(o),
    });
    const pushed = await h.delivery.push(admin.ctx, admin.staff, o.deliveryPlanId, {
      draftLockVersion: 1,
    });
    expect(AdminDeliveryPlanWriteResultSchema.parse(pushed).currentVersionNo).toBe(1);
    const merchant = await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
    expect(DeliveryPlanWriteResultSchema.parse(merchant).status).toBe("confirmed");
    expect(h.rederivations.slice(-2).map((r) => r.steps)).toEqual([
      ["sample_making"],
      ["sample_making"],
    ]);
    for (const id of o.deliveryTicketIds) {
      const t = await h.delivery.get(admin.staff, id);
      expect(DeliveryTicketDetailSchema.parse(t).step).toBe("sample_making");
      expect(t.stages.filter((r) => !r.completedAt).map((r) => r.step)).toEqual(["sample_making"]);
      expect(await h.tx.run((t) => h.counts(t, id))).toEqual({ history: 4, events: 4, audit: 4 });
    }
    for (const code of DELIVERY_INVARIANT_CODES)
      expect(await h.tx.run((t) => findDeliveryViolations(t, code)), code).toEqual([]);
    const list = await h.delivery.list(
      admin.staff,
      TicketListQuerySchema.parse({ orderId: o.order.id }),
    );
    expect(list.total).toBe(2);
  });
  it("已有经理首环节耗时为零；Tf 与建行/首历史/环节一致，预持到账户420后只 INSERT", async () => {
    const owner = await h.make.subscribedMerchant(),
      manager = await h.make.staff({ staffRoleKey: "delivery_manager" });
    await h.prisma.store.update({
      where: { id: owner.store.id },
      data: { deliveryManagerId: manager.id },
    });
    const o = await h.make.dramaOrder({
        entityId: owner.entity.id,
        storeId: owner.store.id,
        status: "producing",
      }),
      item = await h.make.orderItem({ dramaOrderId: o.id, phase: "producing" });
    const at = new Date("2026-01-06T04:00:00Z"),
      ctx = (await h.staff()).ctx;
    const made = await h.tx.run(async (t) => {
      const a = await prepareTicketAssignees(t, o.id),
        b = await prepareTicketAssignees(t, o.id);
      expect(a).toBe(b);
      await lockRows(t, "store", [o.storeId]);
      await lockRows(t, "drama_order", [o.id]);
      await lockRows(t, "order_item", [item.id]);
      await lockRows(t, "billing_account", [owner.billingAccount.entityId]);
      return createTickets(t, h.deps, ctx, { dramaOrderId: o.id, at });
    });
    const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({
        where: { id: made.deliveryTicketIds[0] },
      }),
      stages = await h.prisma.deliveryTicketStage.findMany({
        where: { deliveryTicketId: ticket.id },
      });
    expect(h.rederivations.at(-1)?.steps).toEqual(["plan_confirm"]);
    expect(ticket.createdAt).toEqual(at);
    expect(stages.every((s) => s.enteredAt.getTime() === at.getTime())).toBe(true);
    expect(stages.find((s) => s.step === "assigning")?.completedAt).toEqual(at);
    expect(
      (await h.prisma.statusTransition.findFirstOrThrow({ where: { subjectId: ticket.id } }))
        .occurredAt,
    ).toEqual(at);
  });
  it("prepare 新事务必须重做，建单失败整单回滚；未准备拒绝，正常再次开工不重复", async () => {
    const o = await h.order(true),
      ctx = (await h.staff()).ctx;
    await expect(
      h.tx.run((t) => createTickets(t, h.deps, ctx, { dramaOrderId: o.order.id })),
    ).rejects.toMatchObject({ error: "INTERNAL" });
    const repeat = await h.tx.run(async (t) => {
      await prepareTicketAssignees(t, o.order.id);
      return createTickets(t, h.deps, ctx, { dramaOrderId: o.order.id });
    });
    expect(repeat.deliveryPlanId).toBe(o.deliveryPlanId);
    expect(new Set(repeat.deliveryTicketIds)).toEqual(new Set(o.deliveryTicketIds));
    const order = await h.make.dramaOrder(),
      item = await h.make.orderItem({ dramaOrderId: order.id });
    await expect(
      h.tx.run(async (t) => {
        await prepareTicketAssignees(t, order.id);
        await createTickets(t, h.deps, ctx, { dramaOrderId: order.id });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await h.prisma.deliveryTicket.count({ where: { orderItemId: item.id } })).toBe(0);
    expect(await h.prisma.deliveryPlan.count({ where: { dramaOrderId: order.id } })).toBe(0);
  });
});
