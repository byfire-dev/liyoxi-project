import { describe, expect, it } from "vitest";

import { divRoundHalfUp } from "./round.js";

describe("取整：divRoundHalfUp（四舍五入，整数运算）", () => {
  it.each([
    { n: [0], d: [7], want: 0 },
    { n: [4], d: [10], want: 0 },
    { n: [5], d: [10], want: 1 },
    { n: [15], d: [10], want: 2 },
    // 2.5 进到 3：是四舍五入，不是银行家舍入
    { n: [25], d: [10], want: 3 },
    { n: [7], d: [7], want: 1 },
  ])("round($n ÷ $d) = $want", ({ n, d, want }) => {
    expect(divRoundHalfUp(n, d)).toBe(want);
  });

  it("D1 第 5.1、5.6 节的算例：904.5 → 905；42.5 → 43；2,700 × 10% = 270", () => {
    expect(divRoundHalfUp([1_005, 9_000], [10_000])).toBe(905);
    expect(divRoundHalfUp([50, 8_500], [10_000])).toBe(43);
    expect(divRoundHalfUp([2_700, 1_000], [10_000])).toBe(270);
  });

  it("中间的乘积超过 2^53 也不丢精度", () => {
    // 2,147,483,647 × 10,000 × 20,000 ≈ 4.3 × 10^17，远超 2^53
    expect(divRoundHalfUp([2_147_483_647, 10_000, 20_000], [10_000, 10_000])).toBe(4_294_967_294);
    const max = Number.MAX_SAFE_INTEGER;
    expect(divRoundHalfUp([max, max], [max])).toBe(max);
    // max × 7 在浮点里已经不精确；整数运算得 4,503,599,627,370,495.5 → 进一
    expect(divRoundHalfUp([max, 7], [14])).toBe(4_503_599_627_370_496);
  });

  it.each([
    { name: "分子是小数", n: [1.5], d: [1] },
    { name: "分子是 NaN", n: [Number.NaN], d: [1] },
    { name: "分子是无穷大", n: [Number.POSITIVE_INFINITY], d: [1] },
    { name: "分子超出安全整数", n: [2 ** 53], d: [1] },
    { name: "分子为负", n: [-1], d: [1] },
    { name: "分母为 0", n: [1], d: [0] },
    { name: "分母为负", n: [1], d: [-2] },
    { name: "分母是小数", n: [1], d: [0.5] },
    { name: "没有分子", n: [], d: [1] },
    { name: "没有分母", n: [1], d: [] },
    { name: "结果超出安全整数", n: [Number.MAX_SAFE_INTEGER, 2], d: [1] },
  ])("越界即抛错：$name", ({ n, d }) => {
    expect(() => divRoundHalfUp(n, d)).toThrow(RangeError);
  });
});
