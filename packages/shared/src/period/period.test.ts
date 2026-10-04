// 本文件另由 ../time/tz-process.test.ts 在两个不同的进程时区下各跑一次。

import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { quoteUpgrade } from "../pricing/index.js";
import { addDays, daysInMonth, diffDays, formatLocalDate, parseLocalDate } from "../time/index.js";
import {
  anchorDayOf,
  boundary,
  grantDates,
  grantSchedule,
  monthIndexOf,
  renewTerm,
  termDates,
  upgradePosition,
} from "./index.js";
import type { TermDates } from "./index.js";

const runs = { numRuns: inject("fcRuns"), seed: inject("fcSeed") };
/** 逐期、逐日展开的两条性质比较重：超时随轮次放宽，跑大轮次时不至于误报超时 */
const PROPERTY_TIMEOUT_MS = 30_000 + runs.numRuns * 100;

/** 起始日：2024–2032，日取 1–31 再按当月天数封顶，所以 29、30、31 日与月末出现得多 */
const startDates = fc
  .tuple(
    fc.integer({ min: 2024, max: 2032 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 31 }),
  )
  .map(([year, month, day]) =>
    formatLocalDate(year, month, Math.min(day, daysInMonth(year, month))),
  );
const cycleMonths = fc.constantFrom(1, 3, 12);

const monthNumber = (date: string): number => {
  const { year, month } = parseLocalDate(date);
  return year * 12 + month;
};

/** 表里的一行。用例名由数据拼出来，写法同 03 第 2.3 节的表（月-日），业主可以逐格对照 */
const tableRow = (start: string, months: number, end: string, grants: string[]) => {
  const short = (date: string): string => date.slice(5);
  const period = `本期 ${short(start)} 至 ${short(end)}`;
  return {
    name: `${short(start)} 起 ${months} 个月：${period}；各月发放日 ${grants.map(short).join("、")}`,
    start,
    months,
    end,
    grants,
  };
};

describe("锚定日：03 第 2.3 节的四行（示例按非闰年）", () => {
  const rows = [
    tableRow("2026-09-13", 1, "2026-10-12", ["2026-09-13"]),
    tableRow("2026-09-20", 3, "2026-12-19", ["2026-09-20", "2026-10-20", "2026-11-20"]),
    tableRow("2027-01-31", 1, "2027-02-27", ["2027-01-31"]),
    tableRow("2027-01-31", 3, "2027-04-29", ["2027-01-31", "2027-02-28", "2027-03-31"]),
  ];
  // 不用 it.each：它会把长的用例名截断，业主就没法逐格对照了
  for (const { name, start, months, end, grants } of rows) {
    it(name, () => {
      const term = termDates(start, months);
      expect(term).toEqual({
        startDate: start,
        anchorDay: anchorDayOf(start),
        months,
        endDate: end,
      });
      expect(grantDates(term)).toEqual(grants);
    });
  }
});

describe("锚定日：闰年", () => {
  it("2028-01-31 起 1 个月：跨 2 月的边界是 02-29，本期至 02-28", () => {
    expect(boundary("2028-01-31", 31, 1)).toBe("2028-02-29");
    expect(termDates("2028-01-31", 1).endDate).toBe("2028-02-28");
  });

  it("2028-01-31 起 3 个月：各月发放日 01-31、02-29、03-31，本期至 04-29", () => {
    const term = termDates("2028-01-31", 3);
    expect(grantDates(term)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
    expect(term.endDate).toBe("2028-04-29");
  });

  it("2028-02-29 起 12 个月：锚定日 29，次年 2 月的边界是 02-28，本期至 2029-02-27", () => {
    const term = termDates("2028-02-29", 12);
    expect(term.anchorDay).toBe(29);
    expect(boundary("2028-02-29", 29, 12)).toBe("2029-02-28");
    expect(term.endDate).toBe("2029-02-27");
    expect(grantDates(term)[11]).toBe("2029-01-29");
  });
});

describe("锚定日：D1 第 3.2 节的另三行", () => {
  it("07-04 起 3 个月：本期至 10-03，各月发放日 07-04、08-04、09-04", () => {
    const term = termDates("2026-07-04", 3);
    expect(term.endDate).toBe("2026-10-03");
    expect(grantDates(term)).toEqual(["2026-07-04", "2026-08-04", "2026-09-04"]);
  });

  it("08-30 起 1 个月：本期至 09-29，发放日 08-30", () => {
    const term = termDates("2026-08-30", 1);
    expect(term.endDate).toBe("2026-09-29");
    expect(grantDates(term)).toEqual(["2026-08-30"]);
  });

  it("02-28 起 1 个月、锚定日 31（续接 01-31 起的那一期）：本期至 03-30，不会永久漂到 28 日", () => {
    const first = termDates("2027-01-31", 1);
    const second = renewTerm(first, 1);
    expect(second).toEqual({
      startDate: "2027-02-28",
      anchorDay: 31,
      months: 1,
      endDate: "2027-03-30",
    });
    expect(grantDates(second)).toEqual(["2027-02-28"]);
    // 再续一期回到 31 日
    expect(renewTerm(second, 1).startDate).toBe("2027-03-31");
  });
});

describe("周期：入参校验", () => {
  it("每个边界都从起始月直接算，不在上一个边界上累加", () => {
    expect([0, 1, 2, 3, 4].map((k) => boundary("2027-01-31", 31, k))).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);
    // 跨年
    expect(boundary("2026-11-30", 30, 3)).toBe("2027-02-28");
  });

  it("起始日不在锚定日上即抛错：规则没有定义这种周期，不猜", () => {
    // 09-13 至 10-12 延长 7 天到 10-19，再从 10-20 续接却沿用锚定日 13
    const extended: TermDates = { ...termDates("2026-09-13", 1), endDate: "2026-10-19" };
    expect(() => renewTerm(extended, 1)).toThrow(RangeError);
    expect(() => termDates("2026-10-20", 1, 13)).toThrow(RangeError);
    // 调用方显式重置锚定日即可
    expect(termDates("2026-10-20", 1).endDate).toBe("2026-11-19");
  });

  it.each([
    { name: "月数为 0", run: () => termDates("2026-09-13", 0) },
    { name: "月数是小数", run: () => termDates("2026-09-13", 1.5) },
    { name: "锚定日为 0", run: () => boundary("2026-09-13", 0, 1) },
    { name: "锚定日为 32", run: () => boundary("2026-09-13", 32, 1) },
    { name: "边界序号为负", run: () => boundary("2026-09-13", 13, -1) },
    { name: "起始日不存在", run: () => termDates("2026-02-30", 1) },
    {
      name: "止日早于起始日",
      run: () => grantDates({ ...termDates("2026-09-13", 1), endDate: "2026-09-12" }),
    },
    {
      name: "每月积分为 0",
      run: () => grantSchedule(termDates("2026-09-13", 1), { monthlyPoints: 0, payFen: 100 }),
    },
    {
      name: "实付为负",
      run: () => grantSchedule(termDates("2026-09-13", 1), { monthlyPoints: 1, payFen: -1 }),
    },
  ])("$name 抛错", ({ run }) => {
    expect(run).toThrow(RangeError);
  });
});

describe("发放计划：grantSchedule", () => {
  it("季付 3 个月：每月应发日期 = 各月发放日，成本向下取整，尾差放最后一个月", () => {
    const schedule = grantSchedule(termDates("2026-09-20", 3), {
      monthlyPoints: 6_600,
      payFen: 1_700_000,
    });
    expect(schedule).toEqual([
      { monthNo: 0, dueDate: "2026-09-20", points: 6_600, valueFen: 566_666 },
      { monthNo: 1, dueDate: "2026-10-20", points: 6_600, valueFen: 566_666 },
      { monthNo: 2, dueDate: "2026-11-20", points: 6_600, valueFen: 566_668 },
    ]);
  });
});

describe("升级时所处的位置：upgradePosition", () => {
  const monthly = termDates("2026-09-13", 1);

  it("原型：有效期 09-13 至 10-12，09-30 当天剩 12 天；09-21 至 10-20，09-30 剩 20 天", () => {
    expect(upgradePosition(monthly, "2026-09-30", 30).remainingDays).toBe(12);
    expect(upgradePosition(termDates("2026-09-21", 1), "2026-09-30", 30).remainingDays).toBe(20);
  });

  it("本期最后一天：剩 0 天", () => {
    expect(upgradePosition(monthly, "2026-10-12", 30)).toEqual({
      monthIndex: 0,
      remainingDays: 0,
      remainingFullMonths: 0,
    });
  });

  it("D1 第 5.6 节：月付延长 30 天至 11-11，10-20 升级，月序封顶为 0、剩 22 天，补交 4,400 元、补发 5,720 积分", () => {
    const extended: TermDates = { ...monthly, endDate: "2026-11-11" };
    const position = upgradePosition(extended, "2026-10-20", 30);
    expect(position).toEqual({ monthIndex: 0, remainingDays: 22, remainingFullMonths: 0 });
    expect(
      quoteUpgrade({
        feeDeltaPerMonthFen: 600_000,
        pointsDeltaPerMonth: 7_800,
        baseDays: 30,
        ...position,
      }),
    ).toEqual({ payFen: 440_000, proratedFen: 440_000, topupPoints: 5_720 });
  });

  it("D1 第 5.6 节：末月含延长 15 天（止日 10-27），09-20 升级，37 天按 30 天封顶", () => {
    const extended: TermDates = { ...monthly, endDate: "2026-10-27" };
    expect(upgradePosition(extended, "2026-09-20", 30).remainingDays).toBe(30);
  });

  it("D1 第 5.6 节：年付 01-13 起，第 3 个月剩 12 天升级，其后还有 9 个整月", () => {
    const yearly = termDates("2026-01-13", 12);
    expect(upgradePosition(yearly, "2026-03-31", 30)).toEqual({
      monthIndex: 2,
      remainingDays: 12,
      remainingFullMonths: 9,
    });
    expect(monthIndexOf(yearly, "2026-01-13")).toBe(0);
    expect(monthIndexOf(yearly, "2026-02-12")).toBe(0);
    expect(monthIndexOf(yearly, "2026-02-13")).toBe(1);
    expect(monthIndexOf(yearly, "2027-01-12")).toBe(11);
  });

  it("不在周期内的日期抛错；基准天数必须是正整数", () => {
    expect(() => upgradePosition(monthly, "2026-09-12", 30)).toThrow(RangeError);
    expect(() => upgradePosition(monthly, "2026-10-13", 30)).toThrow(RangeError);
    expect(() => upgradePosition(monthly, "2026-09-30", 0)).toThrow(RangeError);
  });
});

describe("周期性质（D7 第 10.2 节 P4；D1 第 13.1 节）", () => {
  it(
    "任意开通日与月数，连续续费 60 次：各期首尾相接、不重叠，月数正确，锚定日不漂移",
    () => {
      fc.assert(
        fc.property(
          startDates,
          fc.array(cycleMonths, { minLength: 61, maxLength: 61 }),
          (start, cycles) => {
            const anchorDay = anchorDayOf(start);
            // 违规的攒起来一次断言：61 期、每期最多 12 个发放日，逐条断言太慢
            const violations: string[] = [];
            const check = (ok: boolean, what: string, term: TermDates): void => {
              if (!ok) violations.push(`${what}：${JSON.stringify(term)}`);
            };
            let term = termDates(start, cycles[0] ?? 1);
            for (const months of cycles.slice(1)) {
              // 月数正确：止日次日落在“起始月 + 月数”那个月，且是 min(锚定日, 该月最后一天)
              const next = addDays(term.endDate, 1);
              const parts = parseLocalDate(next);
              check(monthNumber(next) - monthNumber(term.startDate) === term.months, "月数", term);
              check(
                parts.day === Math.min(anchorDay, daysInMonth(parts.year, parts.month)),
                "下一个边界不在锚定日上",
                term,
              );

              // 发放日：共 months 个，第一个是起始日，严格递增，都落在本期内
              const grants = grantDates(term);
              check(
                grants.length === term.months && grants[0] === term.startDate,
                "发放日个数",
                term,
              );
              grants.forEach((date, index) => {
                const increasing = index === 0 || diffDays(date, grants[index - 1] ?? "") > 0;
                check(increasing && diffDays(term.endDate, date) >= 0, `发放日 ${date}`, term);
              });

              // 首尾相接、不重叠；锚定日沿用
              const renewed = renewTerm(term, months);
              check(renewed.startDate === next, "首尾没有相接", renewed);
              check(renewed.anchorDay === anchorDay, "锚定日漂移", renewed);
              term = renewed;
            }
            expect(violations).toEqual([]);
          },
        ),
        runs,
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it("任意月数（1–36）：周期由边界直接决定，闰年 2 月的边界是 02-29", () => {
    fc.assert(
      fc.property(startDates, fc.integer({ min: 1, max: 36 }), (start, months) => {
        const term = termDates(start, months);
        const anchorDay = anchorDayOf(start);
        for (let k = 0; k <= months; k += 1) {
          const edge = parseLocalDate(boundary(start, anchorDay, k));
          expect(edge.year * 12 + edge.month).toBe(monthNumber(start) + k);
          expect(edge.day).toBe(Math.min(anchorDay, daysInMonth(edge.year, edge.month)));
          if (edge.month === 2 && anchorDay >= 29) {
            expect(edge.day).toBe(edge.year % 4 === 0 ? 29 : 28);
          }
        }
        expect(addDays(term.endDate, 1)).toBe(boundary(start, anchorDay, months));
      }),
      runs,
    );
  });

  it("发放计划：各行成本之和等于实付，尾差在最后一行，每行积分相同", () => {
    fc.assert(
      fc.property(
        startDates,
        fc.integer({ min: 1, max: 36 }),
        fc.integer({ min: 0, max: 2_147_483_647 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (start, months, payFen, monthlyPoints) => {
          const term = termDates(start, months);
          const schedule = grantSchedule(term, { monthlyPoints, payFen });
          const share = Math.floor(payFen / months);
          expect(schedule.map((row) => row.dueDate)).toEqual(grantDates(term));
          expect(schedule.map((row) => row.monthNo)).toEqual(schedule.map((_, index) => index));
          expect(schedule.every((row) => row.points === monthlyPoints)).toBe(true);
          expect(schedule.slice(0, -1).every((row) => row.valueFen === share)).toBe(true);
          expect(schedule.reduce((sum, row) => sum + row.valueFen, 0)).toBe(payFen);
        },
      ),
      runs,
    );
  });

  it(
    "升级位置：任意周期（含 0–180 天延长）内逐日，各量在界内，应付随日期单调不增",
    () => {
      fc.assert(
        fc.property(
          startDates,
          cycleMonths,
          fc.integer({ min: 0, max: 180 }),
          fc.integer({ min: 1, max: 2_000_000 }),
          fc.integer({ min: 1, max: 100_000 }),
          (start, months, extendedDays, feeDelta, pointsDelta) => {
            const natural = termDates(start, months);
            const term: TermDates = { ...natural, endDate: addDays(natural.endDate, extendedDays) };
            const baseDays = 30;
            // 逐日检查，违规的攒起来一次断言：一期最多五百多天，逐条断言太慢
            const violations: string[] = [];
            let previousPay = Number.POSITIVE_INFINITY;
            for (let day = term.startDate; day <= term.endDate; day = addDays(day, 1)) {
              const position = upgradePosition(term, day, baseDays);
              const { monthIndex, remainingDays, remainingFullMonths } = position;
              const { payFen } = quoteUpgrade({
                feeDeltaPerMonthFen: feeDelta,
                pointsDeltaPerMonth: pointsDelta,
                baseDays,
                remainingDays,
                remainingFullMonths,
              });
              const ok =
                monthIndex >= 0 &&
                monthIndex <= months - 1 &&
                remainingDays >= 0 &&
                remainingDays <= baseDays &&
                remainingFullMonths === months - 1 - monthIndex &&
                payFen >= 0 &&
                payFen <= previousPay;
              if (!ok)
                violations.push(`${day}: ${JSON.stringify({ ...position, payFen, previousPay })}`);
              previousPay = payFen;
            }
            expect(violations).toEqual([]);
            // 本期最后一天：不再有可补的天数与整月
            expect(previousPay).toBe(0);
          },
        ),
        runs,
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
