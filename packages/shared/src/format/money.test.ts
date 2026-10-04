// 本文件另由 ../time/tz-process.test.ts 在两个不同的进程时区下各跑一次。

import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import {
  fenToYuan,
  formatInteger,
  formatMoney,
  formatMoneyFixed,
  formatPoints,
  formatSignedMoney,
  formatSignedMoneyFixed,
  formatSignedPercent,
  formatSignedPoints,
  parseMoney,
  yuanToFen,
} from "./money.js";

const runs = { numRuns: inject("fcRuns"), seed: inject("fcSeed") };

describe("规范 第 7 节的例子", () => {
  it("金额，商家端：¥3,000（整数不带小数）", () => {
    expect(formatMoney(300_000)).toBe("¥3,000");
  });

  it("金额，后台交易金额：¥3,000.00（固定两位小数）", () => {
    expect(formatMoneyFixed(300_000)).toBe("¥3,000.00");
  });

  it("积分：2,160 积分（数字与“积分”之间留一个空格）", () => {
    expect(formatPoints(2_160)).toBe("2,160 积分");
  });

  it("增减，获得：＋1,000（全角加号）", () => {
    expect(formatSignedPoints(1_000)).toBe("＋1,000");
    expect(formatSignedPoints(1_000).codePointAt(0)).toBe(0xff0b);
  });

  it("增减，扣减：−180（U+2212，不是连字符）", () => {
    expect(formatSignedPoints(-180)).toBe("−180");
    expect(formatSignedPoints(-180).codePointAt(0)).toBe(0x2212);
  });

  it("增减，百分比：+11.1%（半角加号）", () => {
    expect(formatSignedPercent(1_110)).toBe("+11.1%");
    expect(formatSignedPercent(1_110).codePointAt(0)).toBe(0x2b);
  });
});

describe("金额", () => {
  it("非整数保留两位；千分位；“¥”后不留空格", () => {
    expect(formatMoney(300_050)).toBe("¥3,000.50");
    expect(formatMoney(29)).toBe("¥0.29");
    expect(formatMoney(110)).toBe("¥1.10");
    expect(formatMoney(0)).toBe("¥0");
    expect(formatMoney(99_900)).toBe("¥999");
    expect(formatMoney(100_000)).toBe("¥1,000");
    expect(formatMoney(7_200_000)).toBe("¥72,000");
    expect(formatMoney(123_456_789_012)).toBe("¥1,234,567,890.12");
  });

  it("固定两位：整数也带 .00", () => {
    expect(formatMoneyFixed(0)).toBe("¥0.00");
    expect(formatMoneyFixed(29)).toBe("¥0.29");
    expect(formatMoneyFixed(17_236_364)).toBe("¥172,363.64");
  });

  it("负数用“−”，写在“¥”前", () => {
    expect(formatMoney(-18_000)).toBe("−¥180");
    expect(formatMoneyFixed(-18_000)).toBe("−¥180.00");
  });

  it("金额增减：获得用全角“＋”，扣减用“−”，0 不带符号", () => {
    expect(formatSignedMoney(100_000)).toBe("＋¥1,000");
    expect(formatSignedMoney(-18_000)).toBe("−¥180");
    expect(formatSignedMoney(0)).toBe("¥0");
    expect(formatSignedMoneyFixed(100_000)).toBe("＋¥1,000.00");
    expect(formatSignedMoneyFixed(-1_850)).toBe("−¥18.50");
  });

  it("不是整数即抛错", () => {
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => formatMoney(bad)).toThrow(RangeError);
      expect(() => formatPoints(bad)).toThrow(RangeError);
      expect(() => formatSignedPercent(bad)).toThrow(RangeError);
    }
  });
});

describe("积分与百分比", () => {
  it("积分：千分位；增减 0 不带符号", () => {
    expect(formatPoints(0)).toBe("0 积分");
    expect(formatPoints(45)).toBe("45 积分");
    expect(formatPoints(189_600)).toBe("189,600 积分");
    expect(formatInteger(1_234_567)).toBe("1,234,567");
    expect(formatInteger(-1_234)).toBe("−1,234");
    expect(formatSignedPoints(0)).toBe("0");
    expect(formatSignedPoints(6_600)).toBe("＋6,600");
    expect(formatSignedPoints(-2_160)).toBe("−2,160");
  });

  it("百分比增减：入参是万分比，半角“+”与“−”，末尾的 0 不写", () => {
    expect(formatSignedPercent(-250)).toBe("−2.5%");
    expect(formatSignedPercent(0)).toBe("0%");
    expect(formatSignedPercent(10_000)).toBe("+100%");
    expect(formatSignedPercent(1_111)).toBe("+11.11%");
    expect(formatSignedPercent(-5)).toBe("−0.05%");
    expect(formatSignedPercent(12_345_600)).toBe("+123,456%");
  });
});

describe("“元”转“分”：按字符串拆分，不用浮点乘 100", () => {
  it.each([
    { yuan: "0.29", fen: 29 },
    { yuan: "1.10", fen: 110 },
    { yuan: "19.99", fen: 1_999 },
  ])("固定样例 $yuan → $fen → $yuan（浮点乘 100 在这三个数上都不精确）", ({ yuan, fen }) => {
    expect(yuanToFen(yuan)).toBe(fen);
    expect(fenToYuan(fen)).toBe(yuan);
  });

  it("整数、一位小数、前导零", () => {
    expect(yuanToFen("3000")).toBe(300_000);
    expect(yuanToFen("19.9")).toBe(1_990);
    expect(yuanToFen("0")).toBe(0);
    expect(yuanToFen("0.00")).toBe(0);
    expect(yuanToFen("007.5")).toBe(750);
    expect(fenToYuan(300_000)).toBe("3000.00");
    expect(fenToYuan(0)).toBe("0.00");
  });

  it.each(["", " ", "1.", ".5", "1.234", "-1", "+1", "1,000", "¥1", "1e3", "１２", "1 ", "abc"])(
    "不合法的输入抛错：%j",
    (text) => {
      expect(() => yuanToFen(text)).toThrow(RangeError);
    },
  );

  it("超出安全整数范围抛错；负数不能转回输入串", () => {
    expect(() => yuanToFen("90071992547409.92")).toThrow(RangeError);
    expect(yuanToFen("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => fenToYuan(-1)).toThrow(RangeError);
  });

  it("显示串解析回分；写法不对即抛错", () => {
    expect(parseMoney("¥3,000")).toBe(300_000);
    expect(parseMoney("¥3,000.00")).toBe(300_000);
    expect(parseMoney("−¥180")).toBe(-18_000);
    expect(parseMoney("＋¥1,000.50")).toBe(100_050);
    for (const bad of ["3,000", "¥3000", "¥3,00", "¥3,000.5", "-¥180", "¥ 3,000", "¥"]) {
      expect(() => parseMoney(bad)).toThrow(RangeError);
    }
  });
});

describe("金额往返性质（D7 第 10.2 节 P9）", () => {
  const fen = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
  const signedFen = fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });

  it("分 → 显示字符串 → 分 恒等（两种小数口径、带不带增减号）", () => {
    fc.assert(
      fc.property(signedFen, (value) => {
        expect(parseMoney(formatMoney(value))).toBe(value);
        expect(parseMoney(formatMoneyFixed(value))).toBe(value);
        expect(parseMoney(formatSignedMoney(value))).toBe(value);
        expect(parseMoney(formatSignedMoneyFixed(value))).toBe(value);
      }),
      runs,
    );
  });

  it("分 → 输入串 → 分 恒等", () => {
    fc.assert(
      fc.property(fen, (value) => {
        expect(yuanToFen(fenToYuan(value))).toBe(value);
      }),
      runs,
    );
  });

  it("任意至多两位小数的输入字符串 → 分 → 字符串 恒等（按数值；写满两位小数的按字面）", () => {
    // 上限留一元的余量：再加两位小数也不超出安全整数
    const whole = fc.bigInt({ min: 0n, max: 90_071_992_547_408n }).map(String);
    const fraction = fc.stringMatching(/^[0-9]{0,2}$/);
    fc.assert(
      fc.property(whole, fraction, fc.nat({ max: 3 }), (digits, decimals, leadingZeros) => {
        const text = `${"0".repeat(leadingZeros)}${digits}${decimals === "" ? "" : `.${decimals}`}`;
        const value = yuanToFen(text);
        // 参考：十进制字符串直接拼成“分”的整数，不经过浮点
        expect(BigInt(value)).toBe(BigInt(`${digits}${decimals.padEnd(2, "0")}`));
        const back = fenToYuan(value);
        expect(yuanToFen(back)).toBe(value);
        if (decimals.length === 2 && leadingZeros === 0) expect(back).toBe(text);
      }),
      runs,
    );
  });

  it("千分位只是加逗号：去掉逗号与单位后就是原数", () => {
    fc.assert(
      fc.property(signedFen, (value) => {
        const digits = formatInteger(value).replace(/,/g, "").replace("−", "-");
        expect(Number(digits)).toBe(value);
        expect(formatPoints(value)).toBe(`${formatInteger(value)} 积分`);
        expect(formatInteger(value)).toMatch(/^−?\d{1,3}(,\d{3})*$/);
      }),
      runs,
    );
  });
});
