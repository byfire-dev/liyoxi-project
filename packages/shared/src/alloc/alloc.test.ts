import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import {
  PointsInsufficientError,
  allocate,
  orderLotsForDeduction,
  planAllocation,
  splitByWeights,
  splitEvenly,
} from "./index.js";
import type { DeductibleLot } from "./index.js";

const runs = { numRuns: inject("fcRuns"), seed: inject("fcSeed") };

const at = (iso: string): Date => new Date(iso);
const lot = (
  id: string,
  kind: "plan" | "addon",
  availableQty: number,
  grantedAt: string,
  expiresAt: string | null = null,
): DeductibleLot => ({
  id,
  kind,
  availableQty,
  grantedAt: at(grantedAt),
  expiresAt: expiresAt === null ? null : at(expiresAt),
});

describe("扣减顺序：orderLotsForDeduction", () => {
  it("套餐批次在前（到期时间升序），加购批次在后（入账时间升序）", () => {
    const lots = [
      lot("addon-new", "addon", 500, "2026-09-10T10:00:00+08:00"),
      lot("plan-late", "plan", 300, "2026-09-13T09:00:00+08:00", "2026-11-13T00:00:00+08:00"),
      lot("addon-old", "addon", 400, "2026-08-01T10:00:00+08:00"),
      lot("plan-soon", "plan", 200, "2026-09-20T09:00:00+08:00", "2026-10-13T00:00:00+08:00"),
    ];
    const snapshot = lots.map((item) => item.id);
    expect(orderLotsForDeduction(lots).map((item) => item.id)).toEqual([
      "plan-soon",
      "plan-late",
      "addon-old",
      "addon-new",
    ]);
    // 不改入参
    expect(lots.map((item) => item.id)).toEqual(snapshot);
  });

  it("同一周期的套餐批次到期时间相同：先后由入账时间决定，再按 id", () => {
    const expires = "2026-10-13T00:00:00+08:00";
    const lots = [
      lot("c-adjust", "plan", 100, "2026-09-25T10:00:00+08:00", expires),
      lot("b-upgrade", "plan", 100, "2026-09-20T10:00:00+08:00", expires),
      lot("a-monthly", "plan", 100, "2026-09-13T09:15:00+08:00", expires),
      lot("a-monthly-0", "plan", 100, "2026-09-13T09:15:00+08:00", expires),
    ];
    expect(orderLotsForDeduction(lots).map((item) => item.id)).toEqual([
      "a-monthly",
      "a-monthly-0",
      "b-upgrade",
      "c-adjust",
    ]);
  });
});

describe("批次分配：allocate、planAllocation", () => {
  const lots = [
    { id: "plan", availableQty: 1_920 },
    { id: "empty", availableQty: 0 },
    { id: "addon", availableQty: 1_000 },
  ];

  it("原型确认订购页：2,592 的来源拆分 1,920 + 672", () => {
    expect(allocate(2_592, lots)).toEqual([
      { lotId: "plan", qty: 1_920 },
      { lotId: "addon", qty: 672 },
    ]);
  });

  it("前一个批次够用就不动后面的；取 0 的批次不出现", () => {
    expect(allocate(1_920, lots)).toEqual([{ lotId: "plan", qty: 1_920 }]);
    expect(allocate(0, lots)).toEqual([]);
  });

  it("不足：allocate 抛错并带缺口数，入参不变；planAllocation 把缺口写在返回值里", () => {
    const before = JSON.stringify(lots);
    let caught: unknown;
    try {
      allocate(3_000, lots);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PointsInsufficientError);
    expect((caught as PointsInsufficientError).shortfall).toBe(80);
    expect(JSON.stringify(lots)).toBe(before);

    expect(planAllocation(3_000, lots)).toEqual({
      allocations: [
        { lotId: "plan", qty: 1_920 },
        { lotId: "addon", qty: 1_000 },
      ],
      allocated: 2_920,
      shortfall: 80,
    });
  });

  it.each([
    { name: "需求量为负", run: () => allocate(-1, lots) },
    { name: "需求量是小数", run: () => allocate(1.5, lots) },
    { name: "批次可用数量为负", run: () => allocate(1, [{ id: "bad", availableQty: -1 }]) },
  ])("入参不合法即抛错：$name", ({ run }) => {
    expect(run).toThrow(RangeError);
  });

  it("性质：分配量之和等于需求量，严格按顺序取满，任一批次不超可用；不足时缺口 = 需求量 − 可用合计", () => {
    const quantities = fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 12 });
    fc.assert(
      fc.property(quantities, fc.integer({ min: 0, max: 1_500_000 }), (available, amount) => {
        const input = available.map((availableQty, index) => ({
          id: `lot-${index}`,
          availableQty,
        }));
        const total = available.reduce((sum, qty) => sum + qty, 0);
        const plan = planAllocation(amount, input);
        const taken = input.map(
          (item) => plan.allocations.find((alloc) => alloc.lotId === item.id)?.qty ?? 0,
        );

        expect(plan.allocated).toBe(Math.min(amount, total));
        expect(plan.shortfall).toBe(Math.max(amount - total, 0));
        expect(taken.reduce((sum, qty) => sum + qty, 0)).toBe(plan.allocated);
        expect(plan.allocations.every((alloc) => alloc.qty > 0)).toBe(true);
        taken.forEach((qty, index) => {
          expect(qty).toBeLessThanOrEqual(available[index] ?? 0);
          // 后面的批次动了，前面的一定已取满
          if (qty > 0) {
            taken.slice(0, index).forEach((earlier, i) => expect(earlier).toBe(available[i]));
          }
        });

        if (amount > total) {
          expect(() => allocate(amount, input)).toThrow(PointsInsufficientError);
        } else {
          expect(allocate(amount, input)).toEqual(plan.allocations);
        }
      }),
      runs,
    );
  });
});

describe("分摊加尾差：splitEvenly、splitByWeights", () => {
  it("平均拆：向下取整，尾差放最后一份", () => {
    expect(splitEvenly(7_200_000, 12)).toEqual(new Array(12).fill(600_000));
    expect(splitEvenly(100, 3)).toEqual([33, 33, 34]);
    expect(splitEvenly(2, 3)).toEqual([0, 0, 2]);
    expect(splitEvenly(0, 2)).toEqual([0, 0]);
    expect(splitEvenly(5, 1)).toEqual([5]);
  });

  it("按权重拆：前面各份向下取整，尾差放最后一份", () => {
    // 6,600 积分对应 600,000 分；一笔 2,160 积分落在 1,920 与 240 两个批次上
    expect(splitByWeights(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(splitByWeights(196_363, [1_920, 240])).toEqual([174_544, 21_819]);
    expect(splitByWeights(10, [7])).toEqual([10]);
  });

  it.each([
    { name: "份数为 0", run: () => splitEvenly(100, 0) },
    { name: "总额为负", run: () => splitEvenly(-1, 2) },
    { name: "没有权重", run: () => splitByWeights(100, []) },
    { name: "权重为 0", run: () => splitByWeights(100, [1, 0]) },
    { name: "权重是小数", run: () => splitByWeights(100, [1, 0.5]) },
  ])("入参不合法即抛错：$name", ({ run }) => {
    expect(run).toThrow(RangeError);
  });

  const totals = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

  it("性质（D7 第 10.2 节 P3）：平均拆，各份之和等于总额，尾差在最后一份", () => {
    fc.assert(
      fc.property(totals, fc.integer({ min: 1, max: 120 }), (total, parts) => {
        const shares = splitEvenly(total, parts);
        const floor = Number(BigInt(total) / BigInt(parts));
        expect(shares).toHaveLength(parts);
        expect(shares.slice(0, -1).every((share) => share === floor)).toBe(true);
        expect(shares.reduce((sum, share) => sum + BigInt(share), 0n)).toBe(BigInt(total));
        // 尾差不到一份的份数
        expect((shares[parts - 1] ?? 0) - floor).toBeLessThan(parts);
      }),
      runs,
    );
  });

  it("性质（P3）：按权重拆，各份之和等于总额，前面各份是向下取整的等比值，尾差在最后一份", () => {
    const weights = fc.array(fc.integer({ min: 1, max: 2_147_483_647 }), {
      minLength: 1,
      maxLength: 12,
    });
    fc.assert(
      fc.property(totals, weights, (total, parts) => {
        const shares = splitByWeights(total, parts);
        const weightSum = parts.reduce((sum, weight) => sum + BigInt(weight), 0n);
        expect(shares).toHaveLength(parts.length);
        expect(shares.reduce((sum, share) => sum + BigInt(share), 0n)).toBe(BigInt(total));
        shares.slice(0, -1).forEach((share, index) => {
          expect(BigInt(share)).toBe((BigInt(total) * BigInt(parts[index] ?? 1)) / weightSum);
        });
        // 最后一份不少于它的等比值：尾差只会多不会少
        const last = parts[parts.length - 1] ?? 1;
        expect(BigInt(shares[shares.length - 1] ?? 0)).toBeGreaterThanOrEqual(
          (BigInt(total) * BigInt(last)) / weightSum,
        );
      }),
      runs,
    );
  });
});
