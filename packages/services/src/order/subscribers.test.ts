import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import type { DeliveredEvent } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import { body } from "./__fixtures__/harness.js";
import { startHarness, pendingCancel, startSnapshot } from "./__fixtures__/start-harness.js";
import type { StartHarness } from "./__fixtures__/start-harness.js";
const db = useSeededDatabase("services");
let h: StartHarness;
beforeAll(async () => {
  h = startHarness(await db.prisma());
}, 120000);
afterAll(() => h?.clear());
function qualification(
  p: Awaited<ReturnType<StartHarness["pending"]>>,
  type = "store.qualification.approved",
): DeliveredEvent {
  return {
    id: uuidv7(),
    type,
    payload: {
      v: 1,
      storeId: p.b.store.id,
      entityId: p.b.entity.id,
      submissionId: uuidv7(),
      ...(type.endsWith("approved")
        ? { kind: "initial" }
        : { isFinal: false, reasonCodes: ["R01"], isSystem: false }),
    },
  };
}
async function deliver(name: string, event: DeliveredEvent) {
  const subscriber = h.assembly.subscriber(name)!;
  return h.tx.run((tx) => subscriber.handle(tx, event));
}
async function snapshot(entityId: string) {
  return {
    business: await startSnapshot(h, entityId),
    timers: await h.prisma.timer.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
  };
}
describe("两个真实已登记订阅者", { timeout: 120000 }, () => {
  it("当前资质通过逐单arm max(now,提交+延迟)，取消不动，迟到重复不推迟且不开工", async () => {
    const p = await h.pending({ gate: "parallel" });
    const second = await h.order.create(
      p.b.actor,
      await body({ ...h, deps: h.orderDeps }, p.b, [p.dramas[0]!.id]),
    );
    const other = await h.pending({ gate: "parallel" });
    await pendingCancel(h, other);
    await h.prisma.store.update({
      where: { id: p.b.store.id },
      data: { qualificationStatus: "verified" },
    });
    const event = qualification(p);
    await deliver("order.onQualificationDecided", event);
    const orders = await h.prisma.dramaOrder.findMany({ where: { storeId: p.b.store.id } });
    expect(orders.map((o) => o.subStatus)).toEqual(["starting", "starting"]);
    for (const order of orders) {
      const params = await h.tx.run((tx) =>
        paramsAt(tx, ["order.start_delay_minutes"], h.clock.now()),
      );
      expect(
        await h.prisma.timer.findFirst({ where: { subjectId: order.id, kind: "order.start" } }),
      ).toMatchObject({
        status: "scheduled",
        fireAt: new Date(
          Math.max(
            h.clock.now().getTime(),
            order.submittedAt.getTime() + params["order.start_delay_minutes"] * 60000,
          ),
        ),
      });
    }
    expect(await h.prisma.deliveryTicket.count({ where: { entityId: p.b.entity.id } })).toBe(0);
    expect(
      await h.prisma.pointHold.count({ where: { entityId: p.b.entity.id, status: "captured" } }),
    ).toBe(0);
    const before = await snapshot(p.b.entity.id);
    h.clock.advance(60000);
    await deliver("order.onQualificationDecided", event);
    expect(await snapshot(p.b.entity.id)).toEqual(before);
    await h.prisma.store.update({
      where: { id: other.b.store.id },
      data: { qualificationStatus: "verified" },
    });
    const cancelledBefore = await snapshot(other.b.entity.id);
    await deliver("order.onQualificationDecided", qualification(other));
    expect(await snapshot(other.b.entity.id)).toEqual(cancelledBefore);
    expect(second.orderId).not.toBe(p.id);
  });
  it("驳回只更新qualification_rejected，无定时器/重复写；旧approved按当前事实拒绝", async () => {
    const p = await h.pending({ gate: "parallel" });
    await h.prisma.store.update({
      where: { id: p.b.store.id },
      data: { qualificationStatus: "rejected" },
    });
    const event = qualification(p, "store.qualification.rejected");
    await deliver("order.onQualificationDecided", event);
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: p.id } })).toMatchObject({
      subStatus: "qualification_rejected",
    });
    expect(await h.prisma.timer.count({ where: { subjectId: p.id } })).toBe(0);
    const before = await snapshot(p.b.entity.id);
    await deliver("order.onQualificationDecided", event);
    await deliver("order.onQualificationDecided", qualification(p));
    expect(await snapshot(p.b.entity.id)).toEqual(before);
  });
  it("套餐生效分配两家启用门店，同步未结订单；已有经理/结束单不动且重复零写", async () => {
    await h.prisma.assignmentPoolMember.deleteMany();
    const manager = await h.pool("delivery_manager"),
      existing = await h.make.staff({ staffRoleKey: "delivery_manager" });
    const p = await h.pending();
    const second = await h.make.store({ entityId: p.b.entity.id });
    const third = await h.make.store({ entityId: p.b.entity.id, deliveryManagerId: existing.id });
    const ended = await h.make.dramaOrder({
      entityId: p.b.entity.id,
      storeId: p.b.store.id,
      subscriptionTermId: p.b.term!.id,
      status: "ended",
    });
    const event: DeliveredEvent = {
      id: uuidv7(),
      type: "billing.subscription.activated",
      payload: {
        v: 1,
        entityId: p.b.entity.id,
        termId: p.b.term!.id,
        planId: p.b.term!.planId,
        startsAt: p.b.term!.startsAt.toISOString(),
        endsAt: p.b.term!.endsAt.toISOString(),
        sourceBillingOrderId: uuidv7(),
      },
    };
    await deliver("order.onSubscriptionActivated", event);
    for (const storeId of [p.b.store.id, second.id])
      expect(await h.prisma.store.findUnique({ where: { id: storeId } })).toMatchObject({
        deliveryManagerId: manager.id,
      });
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: p.id } })).toMatchObject({
      deliveryManagerId: manager.id,
    });
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: ended.id } })).toMatchObject({
      deliveryManagerId: null,
    });
    expect(await h.prisma.store.findUnique({ where: { id: third.id } })).toMatchObject({
      deliveryManagerId: existing.id,
    });
    const before = await snapshot(p.b.entity.id),
      stores = await h.prisma.store.findMany({
        where: { entityId: p.b.entity.id },
        orderBy: { id: "asc" },
      });
    await deliver("order.onSubscriptionActivated", event);
    expect(await snapshot(p.b.entity.id)).toEqual(before);
    expect(
      await h.prisma.store.findMany({ where: { entityId: p.b.entity.id }, orderBy: { id: "asc" } }),
    ).toEqual(stores);
  });
  it("套餐生效但池空：经理、订单、审计与事件都不写，留给开工再次分配", async () => {
    await h.prisma.assignmentPoolMember.deleteMany();
    const p = await h.pending(),
      before = await snapshot(p.b.entity.id),
      store = await h.prisma.store.findUniqueOrThrow({ where: { id: p.b.store.id } });
    await deliver("order.onSubscriptionActivated", {
      id: uuidv7(),
      type: "billing.subscription.activated",
      payload: {
        v: 1,
        entityId: p.b.entity.id,
        termId: p.b.term!.id,
        planId: p.b.term!.planId,
        startsAt: p.b.term!.startsAt.toISOString(),
        endsAt: p.b.term!.endsAt.toISOString(),
        sourceBillingOrderId: uuidv7(),
      },
    });
    expect(await snapshot(p.b.entity.id)).toEqual(before);
    expect(await h.prisma.store.findUnique({ where: { id: store.id } })).toEqual(store);
  });
});
