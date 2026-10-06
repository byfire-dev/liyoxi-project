import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { lockRows } from "../kernel/index.js";
import { syncOrderManager } from "./index.js";
import { harness, buyer, drama, body, version } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
describe("门店交付经理同步端口", () => {
  it("店130→订单160实际锁：显式staffId改写真实2行、同值0行，结束单/外店不改", async () => {
    const b = await buyer(h),
      other = await buyer(h),
      staff = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      d = await drama(h);
    const orders = [
      await h.order.create(b.actor, await body(h, b, [d.id])),
      await h.order.create(b.actor, await body(h, b, [d.id])),
    ];
    const closed = await h.make.dramaOrder({
      entityId: b.entity.id,
      storeId: b.store.id,
      subscriptionTermId: b.term!.id,
      status: "ended",
    });
    const foreign = await h.order.create(other.actor, await body(h, other, [d.id]));
    const sync = () =>
      h.tx.run(async (tx) => {
        await lockRows(tx, "store", [b.store.id]);
        return syncOrderManager(tx, {
          entityId: b.entity.id,
          storeId: b.store.id,
          staffId: staff.id,
          ctx: b.actor.ctx,
        });
      });
    expect(await sync()).toBe(2);
    expect(await sync()).toBe(0);
    expect(
      (await h.prisma.store.findUniqueOrThrow({ where: { id: b.store.id } })).deliveryManagerId,
    ).toBeNull();
    const rows = await h.prisma.dramaOrder.findMany({
      where: { id: { in: orders.map((o) => o.orderId) } },
    });
    expect(rows.every((o) => o.deliveryManagerId === staff.id)).toBe(true);
    for (const id of [closed.id, foreign.orderId])
      expect(
        (await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id } })).deliveryManagerId,
      ).toBeNull();
  });
});
