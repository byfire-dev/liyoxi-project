import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase, checkOrderFixtureInvariants } from "../testing/index.js";
import { harness, buyer, drama, body, version } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { findOrderViolations, ORDER_INVARIANT_CODES } from "./invariants.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
describe("待开工全量不变量", () => {
  it("真实订购后三类全量检查0违规；篡改计数/缺账号/冻结状态能分别发现", async () => {
    const b = await buyer(h),
      d = await drama(h),
      out = await h.order.create(b.actor, await body(h, b, [d.id]));
    const full = await checkOrderFixtureInvariants(h, b.entity.id);
    expect(full).toMatchObject({ status: "succeeded", violationsFound: 0, errors: [] });
    expect(full.checksRun).toBeGreaterThanOrEqual(10);
    for (const code of ORDER_INVARIANT_CODES)
      expect(await h.tx.run((tx) => findOrderViolations(tx, code))).toEqual([]);
    await expect(
      h.prisma.dramaOrder.update({
        where: { id: out.orderId },
        data: { totalChargePoints: out.totalChargePoints + 1 },
      }),
    ).rejects.toThrow(); // 冻结不可变快照由库拦截。
    expect(await h.tx.run((tx) => findOrderViolations(tx, "pending_totals"))).toEqual([]);
    await h.prisma.orderItemAccount.deleteMany({
      where: { orderItemId: out.items[0]!.orderItemId },
    });
    expect(await h.tx.run((tx) => findOrderViolations(tx, "pending_accounts"))).toHaveLength(1);
    const item = await h.prisma.orderItem.findUniqueOrThrow({
      where: { id: out.items[0]!.orderItemId },
    });
    await h.tx.run((tx) =>
      h.ledger.release(tx, {
        pointHoldId: item.pointHoldId,
        reasonClass: "merchant",
        title: { refNo: out.orderNo, dramaTitles: [d.title] },
        ctx: b.actor.ctx,
      }),
    );
    expect(await h.tx.run((tx) => findOrderViolations(tx, "pending_holds"))).toHaveLength(1);
  }, 60000);
});
