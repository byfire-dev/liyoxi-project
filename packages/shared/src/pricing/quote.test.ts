import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import {
  BP_BASE,
  quoteAd,
  quoteAds,
  quoteDramaItem,
  quoteDramaItems,
  quoteUpgrade,
} from "./quote.js";

const runs = { numRuns: inject("fcRuns"), seed: inject("fcSeed") };

/** 参考实现：用精确分数算完再取整。商与余数分开判断，写法与被测函数不同 */
function referenceRound(numerator: bigint, denominator: bigint): number {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(remainder * 2n >= denominator ? quotient + 1n : quotient);
}

const drama = (
  listPricePoints: number,
  discountBp: number,
  options: { surchargeBp?: number; selected?: boolean; included?: boolean } = {},
) =>
  quoteDramaItem({
    listPricePoints,
    discountBp,
    topModelSurchargeBp: options.surchargeBp ?? 2_000,
    isTopModelSelected: options.selected ?? false,
    isTopModelIncluded: options.included ?? false,
  });

describe("订剧报价：quoteDramaItem", () => {
  it("原型算例（D1 第 5.6 节）：2,600 × 0.9 × 1.2 = 2,808", () => {
    expect(drama(2_600, 9_000, { selected: true }).chargePoints).toBe(2_808);
  });

  it("原型确认订购页：2,400 × 0.9 × 1.2 = 2,592；折扣行 −240，加扣行 +432，三行相加等于应扣", () => {
    expect(drama(2_400, 9_000, { selected: true })).toEqual({
      listPricePoints: 2_400,
      discountBp: 9_000,
      surchargeBp: 2_000,
      chargePoints: 2_592,
      discountDeltaPoints: -240,
      surchargeDeltaPoints: 432,
    });
  });

  it("旗舰版已含顶级模型：选不选都不加扣", () => {
    const selected = drama(2_400, 8_000, { selected: true, included: true });
    const notSelected = drama(2_400, 8_000, { selected: false, included: true });
    expect(selected.surchargeBp).toBe(0);
    expect(selected.chargePoints).toBe(1_920);
    expect(notSelected).toEqual(selected);
  });

  it("未选用顶级模型：T = 0", () => {
    expect(drama(2_400, 9_000, { selected: false }).surchargeBp).toBe(0);
  });

  it("逐部取整后求和：1,005 积分 9 折每部 905，两部 1,810（对合计取整是 1,809）", () => {
    const input = {
      listPricePoints: 1_005,
      discountBp: 9_000,
      topModelSurchargeBp: 2_000,
      isTopModelSelected: false,
      isTopModelIncluded: false,
    };
    const quote = quoteDramaItems([input, input]);
    expect(quote.items.map((item) => item.chargePoints)).toEqual([905, 905]);
    expect(quote.totalChargePoints).toBe(1_810);
  });

  it.each([
    { name: "积分价为负", P: -1, R: 9_000, T: 2_000 },
    { name: "积分价是小数", P: 0.5, R: 9_000, T: 2_000 },
    { name: "折扣率写成了 0.9", P: 2_400, R: 0.9, T: 2_000 },
    { name: "折扣率超过 10000", P: 2_400, R: 10_001, T: 2_000 },
    { name: "加扣比例为负", P: 2_400, R: 9_000, T: -1 },
  ])("入参不合法即抛错：$name", ({ P, R, T }) => {
    expect(() => drama(P, R, { surchargeBp: T, selected: true })).toThrow(RangeError);
  });
});

describe("广告报价：quoteAd", () => {
  it("原型算例：旗舰版广告 50 × 0.8 = 40", () => {
    expect(quoteAd(50, 8_000)).toBe(40);
  });

  it("按条取整：8.5 折每条 42.5 → 43，3 条 129", () => {
    expect(quoteAd(50, 8_500)).toBe(43);
    expect(quoteAds(50, 8_500, 3)).toBe(129);
  });
});

describe("升级补差报价：quoteUpgrade", () => {
  it("原型算例：基础版升专业版剩 20 天，补交 2,000 元、补发 2,400 积分", () => {
    expect(
      quoteUpgrade({
        feeDeltaPerMonthFen: 300_000,
        pointsDeltaPerMonth: 3_600,
        remainingDays: 20,
        baseDays: 30,
        remainingFullMonths: 0,
      }),
    ).toEqual({ payFen: 200_000, proratedFen: 200_000, topupPoints: 2_400 });
  });

  it("年付第 3 个月剩 12 天升级：补交 2,400 + 6,000 × 9 = 56,400 元，当即补发 3,120 积分", () => {
    expect(
      quoteUpgrade({
        feeDeltaPerMonthFen: 600_000,
        pointsDeltaPerMonth: 7_800,
        remainingDays: 12,
        baseDays: 30,
        remainingFullMonths: 9,
      }),
    ).toEqual({ payFen: 5_640_000, proratedFen: 240_000, topupPoints: 3_120 });
  });

  it("剩余天数等于基准天数、其后没有整月：恰为一个月的差价与积分差", () => {
    expect(
      quoteUpgrade({
        feeDeltaPerMonthFen: 600_000,
        pointsDeltaPerMonth: 7_800,
        remainingDays: 30,
        baseDays: 30,
        remainingFullMonths: 0,
      }),
    ).toEqual({ payFen: 600_000, proratedFen: 600_000, topupPoints: 7_800 });
  });

  it.each([
    { name: "差价为负", patch: { feeDeltaPerMonthFen: -1 } },
    { name: "积分差为负", patch: { pointsDeltaPerMonth: -1 } },
    { name: "基准天数为 0", patch: { baseDays: 0 } },
    { name: "剩余天数超过基准天数", patch: { remainingDays: 31 } },
    { name: "整月数为负", patch: { remainingFullMonths: -1 } },
  ])("入参不合法即抛错：$name", ({ patch }) => {
    const input = {
      feeDeltaPerMonthFen: 600_000,
      pointsDeltaPerMonth: 7_800,
      remainingDays: 12,
      baseDays: 30,
      remainingFullMonths: 0,
    };
    expect(() => quoteUpgrade({ ...input, ...patch })).toThrow(RangeError);
  });
});

describe("计价性质（D7 第 10.2 节 P2；D1 第 13.1 节）", () => {
  const points = fc.integer({ min: 0, max: 2_147_483_647 });
  const bp = fc.integer({ min: 0, max: BP_BASE });
  const base = BigInt(BP_BASE);

  it("订剧：结果是非负整数，与精确分数算完再取整的参考实现一致，三行相加等于应扣", () => {
    fc.assert(
      fc.property(points, bp, bp, fc.boolean(), fc.boolean(), (P, R, T, selected, included) => {
        const quote = drama(P, R, { surchargeBp: T, selected, included });
        const applied = included || !selected ? 0 : T;
        expect(quote.surchargeBp).toBe(applied);
        expect(Number.isSafeInteger(quote.chargePoints)).toBe(true);
        expect(quote.chargePoints).toBeGreaterThanOrEqual(0);
        expect(quote.chargePoints).toBe(
          referenceRound(BigInt(P) * BigInt(R) * (base + BigInt(applied)), base * base),
        );
        expect(P + quote.discountDeltaPoints + quote.surchargeDeltaPoints).toBe(quote.chargePoints);
        expect(quote.discountDeltaPoints).toBeLessThanOrEqual(0);
        expect(quote.surchargeDeltaPoints).toBeGreaterThanOrEqual(0);
      }),
      runs,
    );
  });

  it("订剧：折扣率越大结果不减；积分价越高结果不减；加扣比例越大结果不减", () => {
    fc.assert(
      fc.property(points, points, bp, bp, bp, bp, (p1, p2, r1, r2, t1, t2) => {
        const [pLow, pHigh] = p1 <= p2 ? [p1, p2] : [p2, p1];
        const [rLow, rHigh] = r1 <= r2 ? [r1, r2] : [r2, r1];
        const [tLow, tHigh] = t1 <= t2 ? [t1, t2] : [t2, t1];
        const charge = (P: number, R: number, T: number) =>
          drama(P, R, { surchargeBp: T, selected: true }).chargePoints;
        expect(charge(pLow, rLow, tLow)).toBeLessThanOrEqual(charge(pLow, rHigh, tLow));
        expect(charge(pLow, rLow, tLow)).toBeLessThanOrEqual(charge(pHigh, rLow, tLow));
        expect(charge(pLow, rLow, tLow)).toBeLessThanOrEqual(charge(pLow, rLow, tHigh));
      }),
      runs,
    );
  });

  it("订剧：不加扣时应扣不超过积分价；旗舰版的结果与是否选用顶级模型无关", () => {
    fc.assert(
      fc.property(points, bp, bp, (P, R, T) => {
        expect(drama(P, R, { surchargeBp: T }).chargePoints).toBeLessThanOrEqual(P);
        expect(drama(P, R, { surchargeBp: T, selected: true, included: true })).toEqual(
          drama(P, R, { surchargeBp: T, selected: false, included: true }),
        );
      }),
      runs,
    );
  });

  it("广告：结果是非负整数，与参考实现一致，折扣率越大结果不减", () => {
    fc.assert(
      fc.property(points, bp, bp, (unit, r1, r2) => {
        const [rLow, rHigh] = r1 <= r2 ? [r1, r2] : [r2, r1];
        const quote = quoteAd(unit, rLow);
        expect(Number.isSafeInteger(quote)).toBe(true);
        expect(quote).toBeGreaterThanOrEqual(0);
        expect(quote).toBe(referenceRound(BigInt(unit) * BigInt(rLow), base));
        expect(quote).toBeLessThanOrEqual(quoteAd(unit, rHigh));
      }),
      runs,
    );
  });

  it("升级补差：与参考实现一致；应付、补发都不为负", () => {
    const days = fc.integer({ min: 1, max: 366 });
    const months = fc.integer({ min: 0, max: 35 });
    fc.assert(
      fc.property(points, points, days, days, months, (feeDelta, pointsDelta, d1, d2, m) => {
        const [remainingDays, baseDays] = d1 <= d2 ? [d1, d2] : [d2, d1];
        const quote = quoteUpgrade({
          feeDeltaPerMonthFen: feeDelta,
          pointsDeltaPerMonth: pointsDelta,
          remainingDays,
          baseDays,
          remainingFullMonths: m,
        });
        const prorated = referenceRound(BigInt(feeDelta) * BigInt(remainingDays), BigInt(baseDays));
        expect(quote.proratedFen).toBe(prorated);
        expect(quote.payFen).toBe(prorated + feeDelta * m);
        expect(quote.topupPoints).toBe(
          referenceRound(BigInt(pointsDelta) * BigInt(remainingDays), BigInt(baseDays)),
        );
        expect(quote.payFen).toBeGreaterThanOrEqual(0);
        expect(quote.topupPoints).toBeGreaterThanOrEqual(0);
      }),
      runs,
    );
  });
});
