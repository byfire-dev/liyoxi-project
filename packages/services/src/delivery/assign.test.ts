import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { lockRows } from "../kernel/index.js";
import { deliveryManagerPort, orderManagerPort } from "../profile/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
describe("工单分配守卫与同事务同步", { timeout: 60000 }, () => {
  it("未启用/角色/范围分别拒绝；不泄漏范围外工单；直接 profile 端口返回实际工单数", async () => {
    const o = await h.order(false, 2),
      a = await h.staff(),
      disabled = await h.make.staff({ staffRoleKey: "delivery_manager", status: "pending" }),
      wrong = await h.make.staff({ staffRoleKey: "publisher" }),
      outside = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      lead = await h.staff("delivery_manager");
    const closed = await h.make.dramaOrder({
      entityId: o.entity.id,
      storeId: o.store.id,
      status: "ended",
      deliveryManagerId: lead.row.id,
    });
    for (const [staffId, reason] of [
      [disabled.id, "not_active"],
      [wrong.id, "role_mismatch"],
    ])
      await expect(
        h.delivery.assign(a.ctx, a.staff, o.deliveryTicketIds[0]!, { staffId: staffId! }),
      ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason } });
    await expect(
      h.delivery.assign(lead.ctx, lead.staff, o.deliveryTicketIds[0]!, { staffId: outside.id }),
    ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason: "out_of_scope" } });
    const publisher = await h.staff("publisher"),
      otherPublisher = await h.make.staff({ staffRoleKey: "publisher" });
    await h.prisma.deliveryTicket.update({
      where: { id: o.deliveryTicketIds[0]! },
      data: { publisherId: otherPublisher.id },
    });
    await expect(h.delivery.get(publisher.staff, o.deliveryTicketIds[0]!)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const result = await h.tx.run((tx) =>
      h.profile.assignDeliveryManager(tx, a.ctx, {
        storeId: o.store.id,
        staffId: outside.id,
        scope: a.staff.scope,
      }),
    );
    expect(result.synced).toEqual({ dramaOrderCount: 1, deliveryTicketCount: 2 });
    expect(
      (await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: o.order.id } }))
        .deliveryManagerId,
    ).toBe(outside.id);
    for (const id of o.deliveryTicketIds)
      expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({
        step: "plan_confirm",
        deliveryManagerId: outside.id,
      });
    // profile 的首次指派仍拒绝重复；已合 order/delivery 同步端口同值返回真实零行。
    const repeated = await h.tx.run(async (tx) => {
      await lockRows(tx, "store", [o.store.id]);
      const assignment = {
        entityId: o.entity.id,
        storeId: o.store.id,
        staffId: outside.id,
        ctx: a.ctx,
      };
      return {
        dramaOrderCount: await h.assembly.port(orderManagerPort)(tx, assignment),
        deliveryTicketCount: await h.assembly.port(deliveryManagerPort)(tx, assignment),
      };
    });
    expect(repeated).toEqual({ dramaOrderCount: 0, deliveryTicketCount: 0 });
    expect(
      (await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: closed.id } })).deliveryManagerId,
    ).toBe(lead.row.id);
  });
  it("暂停目标不能借首次经理批量分配返回成功；全事务保持门店和其他工单未分配", async () => {
    const o = await h.order(false, 2),
      a = await h.staff(),
      m = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      id = o.deliveryTicketIds[0]!;
    await h.prisma.deliveryTicket.update({
      where: { id },
      data: { pauseCount: 1, pausedAt: h.clock.now() },
    });
    await expect(h.delivery.assign(a.ctx, a.staff, id, { staffId: m.id })).rejects.toMatchObject({
      error: "TICKET_ON_HOLD",
    });
    expect(
      (await h.prisma.store.findUniqueOrThrow({ where: { id: o.store.id } })).deliveryManagerId,
    ).toBeNull();
    expect(
      await h.prisma.deliveryTicket.count({
        where: { dramaOrderId: o.order.id, step: "assigning" },
      }),
    ).toBe(2);
  });
  it("已有门店经理只分配目标工单；状态/本人反例拒绝且零新增事件", async () => {
    const o = await h.order(true, 2),
      a = await h.staff(),
      m = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      id = o.deliveryTicketIds[0]!;
    await expect(
      h.delivery.assign(a.ctx, a.staff, id, { staffId: o.store.deliveryManagerId! }),
    ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason: "same_as_current" } });
    await expect(h.delivery.assign(a.ctx, a.staff, id, { staffId: m.id })).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: id, eventType: "ticket.assigned" },
      }),
    ).toBe(0);
  });
});
