import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase, topUp } from "../testing/index.js";
import { harness, buyer, drama, body, version } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
const seed = Number(process.env["LYX_FC_SEED"] ?? 115),
  numRuns = Number(process.env["LYX_FC_RUNS"] ?? 200);
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
describe(`订剧真库性质 seed=${seed} runs=${numRuns}`, { timeout: 600000 }, () => {
  it("逐部 HALF_UP 后求和；三部与独立整数有理数计算相等", async () => {
    const b = await buyer(h);
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.integer({ min: 100, max: 1000 }),
          fc.integer({ min: 100, max: 1000 }),
          fc.integer({ min: 100, max: 1000 }),
        ),
        fc.boolean(),
        async (prices, top) => {
          const ds = [];
          for (const p of prices) ds.push(await drama(h, p));
          const q = await h.order.quote(b.actor, {
            dramaIds: ds.map((d) => d.id),
            isTopModel: top,
          });
          const surcharge = top ? q.plan.topModelSurchargeBp : 0;
          const expected = prices.map((P) =>
            Number((BigInt(P) * 9000n * BigInt(10000 + surcharge) + 50000000n) / 100000000n),
          );
          expect(q.expect.items.map((i) => i.chargePoints)).toEqual(expected);
          expect(q.totalChargePoints).toBe(expected.reduce((a, b) => a + b, 0));
        },
      ),
      { seed, numRuns },
    );
  });
  it("同一时刻真实报价expect提交必过，冻结与订单数量逐项一致", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 100, max: 700 }), { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        async (prices, top) => {
          const b = await buyer(h),
            ds = [];
          for (const p of prices) ds.push(await drama(h, p));
          const input = await body(
              h,
              b,
              ds.map((d) => d.id),
              top,
            ),
            out = await h.order.create(b.actor, input);
          expect(out.totalChargePoints).toBe(input.expect.totalChargePoints);
          expect(out.items.map((i) => i.chargePoints)).toEqual(
            input.expect.items.map((i) => i.chargePoints),
          );
          const holds = await h.prisma.pointHold.findMany({
            where: { entityId: b.entity.id, refType: "order_item" },
          });
          expect(holds.reduce((n, s) => n + s.qty, 0)).toBe(out.totalChargePoints);
          expect(holds.every((s) => s.status === "held")).toBe(true);
        },
      ),
      { seed: seed + 1, numRuns },
    );
  });
  it("真实套餐+加购两类批次：预览顺序/数量与hold分摊一致", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.integer({ min: 2700, max: 3000 }),
          fc.integer({ min: 2700, max: 3000 }),
          fc.integer({ min: 2700, max: 3000 }),
        ),
        async (prices) => {
          const b = await buyer(h);
          await topUp(h, { entityId: b.entity.id, points: 5000 });
          const ds = [];
          for (const p of prices) ds.push(await drama(h, p));
          const input = await body(
              h,
              b,
              ds.map((d) => d.id),
            ),
            q = await h.order.quote(b.actor, { dramaIds: input.dramaIds, isTopModel: false }),
            out = await h.order.create(b.actor, input);
          const items = await h.prisma.orderItem.findMany({ where: { dramaOrderId: out.orderId } }),
            alloc = await h.prisma.pointHoldAlloc.findMany({
              where: { pointHoldId: { in: items.map((i) => i.pointHoldId) } },
              include: { pointLot: true },
            });
          const plan = alloc.filter((a) => a.lotKind === "plan"),
            addon = alloc.filter((a) => a.lotKind === "addon");
          expect(plan.reduce((n, a) => n + a.qty, 0)).toBe(
            q.allocation.planLots.reduce((n, a) => n + a.points, 0),
          );
          expect(addon.reduce((n, a) => n + a.qty, 0)).toBe(q.allocation.addonPoints);
          expect(q.allocation.planLots[0]!.expiresAt).toBe(
            plan[0]!.pointLot.expiresAt!.toISOString(),
          );
          expect(addon.length).toBeGreaterThan(0);
        },
      ),
      { seed: seed + 2, numRuns },
    );
  });
});
