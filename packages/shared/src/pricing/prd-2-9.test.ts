// PRD 2.9 的七个示例。PRD 不在仓库里，以 03 第 2.5 节的验算表为准；输入值取自 D1 第 5.6 节。
// 业主对照 03 第 2.5 节的表逐条看：每条用例名里写着算式与结果。

import { describe, expect, it } from "vitest";

import { allocate, orderLotsForDeduction } from "../alloc/index.js";
import type { DeductibleLot } from "../alloc/index.js";
import { formatMoney, formatPoints } from "../format/money.js";
import { grantSchedule, termDates, upgradePosition } from "../period/index.js";
import { quoteAd, quoteAds, quoteDramaItem, quoteDramaItems, quoteUpgrade } from "./quote.js";

/** 专业版：9 折，标准模型之外选顶级模型加扣 20% */
const TOP_MODEL_SURCHARGE_BP = 2_000;

const drama = (listPricePoints: number, discountBp: number, isTopModelSelected = false) => ({
  listPricePoints,
  discountBp,
  topModelSurchargeBp: TOP_MODEL_SURCHARGE_BP,
  isTopModelSelected,
  isTopModelIncluded: false,
});

describe("PRD 2.9 七例（03 第 2.5 节）", () => {
  it("例 1：round(2,400 × 0.9) = 2,160", () => {
    const quote = quoteDramaItem(drama(2_400, 9_000));
    expect(quote.chargePoints).toBe(2_160);
    expect(formatPoints(quote.chargePoints)).toBe("2,160 积分");
  });

  it("例 2：round(2,400 × 1 × 1.2) = 2,880", () => {
    const quote = quoteDramaItem(drama(2_400, 10_000, true));
    expect(quote.surchargeBp).toBe(2_000);
    expect(quote.chargePoints).toBe(2_880);
  });

  it("例 3：round(3,000 × 0.9) + round(2,000 × 0.9) = 2,700 + 1,800 = 4,500", () => {
    const quote = quoteDramaItems([drama(3_000, 9_000), drama(2_000, 9_000)]);
    expect(quote.items.map((item) => item.chargePoints)).toEqual([2_700, 1_800]);
    expect(quote.totalChargePoints).toBe(4_500);
  });

  it("例 4：round(50 × 0.9) × 2 = 45 × 2 = 90", () => {
    expect(quoteAd(50, 9_000)).toBe(45);
    expect(quoteAds(50, 9_000, 2)).toBe(90);
  });

  it("例 5：冻结 2,160，先取套餐批次 1,920，再取加购批次 240，加购剩 760", () => {
    const lots: DeductibleLot[] = [
      // 故意把加购批次放在前面：顺序由 orderLotsForDeduction 决定，不看传入的先后
      {
        id: "lot-addon",
        kind: "addon",
        availableQty: 1_000,
        grantedAt: new Date("2026-08-20T10:00:00+08:00"),
        expiresAt: null,
      },
      {
        id: "lot-plan",
        kind: "plan",
        availableQty: 1_920,
        grantedAt: new Date("2026-09-13T09:15:00+08:00"),
        expiresAt: new Date("2026-10-13T00:00:00+08:00"),
      },
    ];
    const hold = quoteDramaItem(drama(2_400, 9_000)).chargePoints;
    expect(hold).toBe(2_160);

    const allocations = allocate(hold, orderLotsForDeduction(lots));
    expect(allocations).toEqual([
      { lotId: "lot-plan", qty: 1_920 },
      { lotId: "lot-addon", qty: 240 },
    ]);
    const addonTaken = allocations.find((item) => item.lotId === "lot-addon")?.qty ?? 0;
    expect(1_000 - addonTaken).toBe(760);
  });

  it("例 6：专业版年付 6,000 × 12 = 72,000 元，发放计划 12 行，每行 6,600 积分", () => {
    const monthlyFeeFen = 600_000;
    const payFen = monthlyFeeFen * 12;
    expect(payFen).toBe(7_200_000);
    expect(formatMoney(payFen)).toBe("¥72,000");

    const schedule = grantSchedule(termDates("2026-09-13", 12), { monthlyPoints: 6_600, payFen });
    expect(schedule).toHaveLength(12);
    expect(schedule.map((row) => row.monthNo)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const row of schedule) {
      expect(row.points).toBe(6_600);
      // 每行成本 6,000 元
      expect(row.valueFen).toBe(600_000);
    }
    expect(schedule.reduce((sum, row) => sum + row.valueFen, 0)).toBe(payFen);
  });

  it("例 7：(12,000 − 6,000) × 12 ÷ 30 = 补交 2,400 元；(14,400 − 6,600) × 12 ÷ 30 = 补发 3,120 积分", () => {
    // 专业版月付 09-13 至 10-12，09-30 升旗舰版：本月剩 12 天，按 30 天计
    const position = upgradePosition(termDates("2026-09-13", 1), "2026-09-30", 30);
    expect(position).toEqual({ monthIndex: 0, remainingDays: 12, remainingFullMonths: 0 });

    const quote = quoteUpgrade({
      feeDeltaPerMonthFen: 1_200_000 - 600_000,
      pointsDeltaPerMonth: 14_400 - 6_600,
      remainingDays: position.remainingDays,
      baseDays: 30,
      remainingFullMonths: position.remainingFullMonths,
    });
    expect(quote.payFen).toBe(240_000);
    expect(formatMoney(quote.payFen)).toBe("¥2,400");
    expect(quote.topupPoints).toBe(3_120);
    expect(formatPoints(quote.topupPoints)).toBe("3,120 积分");
  });
});
