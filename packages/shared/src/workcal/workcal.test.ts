// 本文件另由 ../time/tz-process.test.ts 在两个不同的进程时区下各跑一次。
//
// 日历夹具按原型示例反推（任务书 第 11 节第 7 项）：2026 年全年按周一至周五铺底，
// 10-01 至 10-07 放假，10-10（周六）调休上班；2026 年以外的日期日历里没有。
// 夹具只在测试里，正式日历的种子在 W0-21。

import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { dayOfWeek } from "../time/index.js";
import {
  addWorkingDays,
  addWorkingMinutes,
  dueAt,
  nextWorkStart,
  nthWorkdayAfter,
  sameDayCutoff,
  workingMinutesBetween,
} from "./index.js";
import type { WorkCalendar } from "./index.js";

const runs = { numRuns: inject("fcRuns"), seed: inject("fcSeed") };

const HOLIDAYS = new Set([
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
]);
const ADJUSTED_WORKDAYS = new Set(["2026-10-10"]);

const calendar: WorkCalendar = {
  workStartMinute: 9 * 60,
  workEndMinute: 18 * 60,
  isWorkday(date) {
    if (!date.startsWith("2026-")) return undefined;
    if (HOLIDAYS.has(date)) return false;
    if (ADJUSTED_WORKDAYS.has(date)) return true;
    return dayOfWeek(date) <= 5;
  },
};

/** 北京时间的 `YYYY-MM-DD HH:mm[:ss.sss]` → 时刻 */
const bj = (text: string): Date => new Date(`${text.replace(" ", "T")}+08:00`);
const NO_FALLBACK = { usedFallback: false, fallbackDates: [] };

describe("工作日：两条原型示例（D3 第 22.2 节）", () => {
  it("09-30 08:15 加 1 个工作日 = 10-08 08:15（跨国庆）", () => {
    expect(addWorkingDays(calendar, bj("2026-09-30 08:15"), 1)).toEqual({
      at: bj("2026-10-08 08:15"),
      ...NO_FALLBACK,
    });
  });

  it("09-29 11:40 加 1 个工作日 = 次日 11:40", () => {
    expect(addWorkingDays(calendar, bj("2026-09-29 11:40"), 1).at).toEqual(bj("2026-09-30 11:40"));
  });
});

describe("时限策略：五种单位各一例（14 分组 第 4.2 节）", () => {
  it("work_minutes：09-30 17:00 起 120 个工作分钟，当天用掉 60，余下落到 10-08 10:00", () => {
    expect(dueAt(calendar, bj("2026-09-30 17:00"), { amount: 120, unit: "work_minutes" })).toEqual({
      at: bj("2026-10-08 10:00"),
      ...NO_FALLBACK,
    });
  });

  it("work_days：09-30 08:15 起 1 个工作日 = 10-08 08:15", () => {
    expect(dueAt(calendar, bj("2026-09-30 08:15"), { amount: 1, unit: "work_days" }).at).toEqual(
      bj("2026-10-08 08:15"),
    );
  });

  it("natural_hours：09-30 20:00 起 24 个自然小时 = 10-01 20:00，不看放假", () => {
    expect(dueAt(calendar, bj("2026-09-30 20:00"), { amount: 24, unit: "natural_hours" })).toEqual({
      at: bj("2026-10-01 20:00"),
      ...NO_FALLBACK,
    });
  });

  it("natural_days：09-30 10:00 起 3 个自然日 = 10-03 10:00，不看放假", () => {
    expect(dueAt(calendar, bj("2026-09-30 10:00"), { amount: 3, unit: "natural_days" }).at).toEqual(
      bj("2026-10-03 10:00"),
    );
  });

  it("same_day_cutoff（1080 = 18:00）：没到截止时刻是当日 18:00；到了或过了落到下一个工作日", () => {
    const policy = { amount: 1_080, unit: "same_day_cutoff" } as const;
    expect(dueAt(calendar, bj("2026-09-30 10:00"), policy).at).toEqual(bj("2026-09-30 18:00"));
    expect(dueAt(calendar, bj("2026-09-30 17:59:59.999"), policy).at).toEqual(
      bj("2026-09-30 18:00"),
    );
    expect(dueAt(calendar, bj("2026-09-30 18:00"), policy).at).toEqual(bj("2026-10-08 18:00"));
    expect(dueAt(calendar, bj("2026-09-30 18:30"), policy).at).toEqual(bj("2026-10-08 18:00"));
    // 放假日提交：下一个工作日的截止时刻
    expect(sameDayCutoff(calendar, bj("2026-10-03 10:00"), 1_080).at).toEqual(
      bj("2026-10-08 18:00"),
    );
  });

  it("数量不合法即抛错", () => {
    expect(() =>
      dueAt(calendar, bj("2026-09-30 10:00"), { amount: -1, unit: "work_days" }),
    ).toThrow(RangeError);
    expect(() =>
      dueAt(calendar, bj("2026-09-30 10:00"), { amount: 1.5, unit: "natural_hours" }),
    ).toThrow(RangeError);
    expect(() =>
      dueAt(calendar, bj("2026-09-30 10:00"), { amount: 1_441, unit: "same_day_cutoff" }),
    ).toThrow(RangeError);
  });
});

describe("调休上班日与放假日", () => {
  it("调休上班日（10-10 周六）算工作日", () => {
    expect(addWorkingDays(calendar, bj("2026-10-09 10:00"), 1).at).toEqual(bj("2026-10-10 10:00"));
    expect(nextWorkStart(calendar, bj("2026-10-10 08:00")).at).toEqual(bj("2026-10-10 09:00"));
    expect(nthWorkdayAfter(calendar, "2026-10-09", 1).date).toBe("2026-10-10");
    expect(nthWorkdayAfter(calendar, "2026-10-09", 2).date).toBe("2026-10-12");
    expect(
      workingMinutesBetween(calendar, bj("2026-10-10 09:00"), bj("2026-10-10 18:00")).minutes,
    ).toBe(540);
  });

  it("普通周六（10-17）不算工作日", () => {
    expect(nextWorkStart(calendar, bj("2026-10-17 10:00")).at).toEqual(bj("2026-10-19 09:00"));
    expect(addWorkingDays(calendar, bj("2026-10-16 10:00"), 1).at).toEqual(bj("2026-10-19 10:00"));
  });

  it("放假日（10-01 至 10-07）不算工作日，哪怕落在周一至周五", () => {
    expect(nextWorkStart(calendar, bj("2026-10-05 10:00")).at).toEqual(bj("2026-10-08 09:00"));
    expect(nthWorkdayAfter(calendar, "2026-09-30", 1).date).toBe("2026-10-08");
    // 放假日提交：从下一个工作日的上班时刻起算
    expect(addWorkingDays(calendar, bj("2026-10-03 14:00"), 1).at).toEqual(bj("2026-10-09 09:00"));
    expect(addWorkingDays(calendar, bj("2026-10-03 14:00"), 0).at).toEqual(bj("2026-10-08 09:00"));
    expect(
      workingMinutesBetween(calendar, bj("2026-09-30 17:00"), bj("2026-10-08 10:00")).minutes,
    ).toBe(120);
  });
});

describe("超出日历范围：按周一至周五兜底，并在返回值里标出", () => {
  it("日历里有的日期：不标", () => {
    expect(addWorkingDays(calendar, bj("2026-12-30 10:00"), 1)).toEqual({
      at: bj("2026-12-31 10:00"),
      ...NO_FALLBACK,
    });
  });

  it("2027-01-01（周五）不在日历里：按工作日算，标出用了兜底的日期", () => {
    expect(addWorkingDays(calendar, bj("2026-12-31 10:00"), 1)).toEqual({
      at: bj("2027-01-01 10:00"),
      usedFallback: true,
      fallbackDates: ["2027-01-01"],
    });
  });

  it("兜底时周末不算工作日", () => {
    expect(nthWorkdayAfter(calendar, "2027-01-01", 1)).toEqual({
      date: "2027-01-04",
      usedFallback: true,
      fallbackDates: ["2027-01-02", "2027-01-03", "2027-01-04"],
    });
    expect(addWorkingMinutes(calendar, bj("2026-12-31 17:30"), 60)).toEqual({
      at: bj("2027-01-01 09:30"),
      usedFallback: true,
      fallbackDates: ["2027-01-01"],
    });
    expect(sameDayCutoff(calendar, bj("2027-01-02 10:00"), 1_080)).toEqual({
      at: bj("2027-01-04 18:00"),
      usedFallback: true,
      fallbackDates: ["2027-01-02", "2027-01-03", "2027-01-04"],
    });
    expect(workingMinutesBetween(calendar, bj("2026-12-31 17:00"), bj("2027-01-04 10:00"))).toEqual(
      {
        minutes: 60 + 540 + 60,
        usedFallback: true,
        fallbackDates: ["2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"],
      },
    );
  });
});

describe("六个函数的边界", () => {
  it("nextWorkStart：工作时段内返回原时刻；上班前到上班时刻；下班时刻起算到下一个工作日", () => {
    expect(nextWorkStart(calendar, bj("2026-09-29 11:40:30.500")).at).toEqual(
      bj("2026-09-29 11:40:30.500"),
    );
    expect(nextWorkStart(calendar, bj("2026-09-29 09:00")).at).toEqual(bj("2026-09-29 09:00"));
    expect(nextWorkStart(calendar, bj("2026-09-29 08:15")).at).toEqual(bj("2026-09-29 09:00"));
    expect(nextWorkStart(calendar, bj("2026-09-29 18:00")).at).toEqual(bj("2026-09-30 09:00"));
    expect(nextWorkStart(calendar, bj("2026-09-29 23:59")).at).toEqual(bj("2026-09-30 09:00"));
  });

  it("addWorkingMinutes：恰好累计到下班时刻的落在当日下班时刻；跨多个工作日；保留秒", () => {
    expect(addWorkingMinutes(calendar, bj("2026-09-29 17:00"), 60).at).toEqual(
      bj("2026-09-29 18:00"),
    );
    expect(addWorkingMinutes(calendar, bj("2026-09-29 17:00"), 61).at).toEqual(
      bj("2026-09-30 09:01"),
    );
    expect(addWorkingMinutes(calendar, bj("2026-09-29 08:00"), 30).at).toEqual(
      bj("2026-09-29 09:30"),
    );
    expect(addWorkingMinutes(calendar, bj("2026-09-29 20:00"), 0).at).toEqual(
      bj("2026-09-30 09:00"),
    );
    // 09-29 剩 7 小时 20 分，09-30 一整天 9 小时，余下 100 分钟落到 10-08
    expect(addWorkingMinutes(calendar, bj("2026-09-29 10:40"), 440 + 540 + 100).at).toEqual(
      bj("2026-10-08 10:40"),
    );
    expect(addWorkingMinutes(calendar, bj("2026-09-29 10:40:15"), 30).at).toEqual(
      bj("2026-09-29 11:10:15"),
    );
  });

  it("addWorkingDays：0 个工作日返回起算时刻；下班后提交保留钟点", () => {
    expect(addWorkingDays(calendar, bj("2026-09-29 11:40"), 0).at).toEqual(bj("2026-09-29 11:40"));
    expect(addWorkingDays(calendar, bj("2026-09-29 20:30"), 2).at).toEqual(bj("2026-10-08 20:30"));
    expect(addWorkingDays(calendar, bj("2026-09-23 10:00"), 7).at).toEqual(bj("2026-10-09 10:00"));
  });

  it("workingMinutesBetween：同一时刻为 0；不足一分钟舍去；结束早于开始抛错", () => {
    const start = bj("2026-09-29 10:00");
    expect(workingMinutesBetween(calendar, start, start).minutes).toBe(0);
    expect(workingMinutesBetween(calendar, start, bj("2026-09-29 10:01:59")).minutes).toBe(1);
    expect(
      workingMinutesBetween(calendar, bj("2026-09-29 07:00"), bj("2026-09-29 22:00")).minutes,
    ).toBe(540);
    expect(() => workingMinutesBetween(calendar, bj("2026-09-29 10:01"), start)).toThrow(
      RangeError,
    );
  });

  it("入参不合法即抛错", () => {
    expect(() => nthWorkdayAfter(calendar, "2026-09-29", 0)).toThrow(RangeError);
    expect(() => addWorkingDays(calendar, bj("2026-09-29 10:00"), -1)).toThrow(RangeError);
    expect(() => addWorkingMinutes(calendar, bj("2026-09-29 10:00"), 0.5)).toThrow(RangeError);
    expect(() => nextWorkStart(calendar, new Date(Number.NaN))).toThrow(RangeError);
    const badHours = { ...calendar, workStartMinute: 1_080, workEndMinute: 540 };
    expect(() => nextWorkStart(badHours, bj("2026-09-29 10:00"))).toThrow(RangeError);
  });

  it("日历里一个工作日都没有：找 366 天后抛错，不死循环", () => {
    const never: WorkCalendar = { ...calendar, isWorkday: () => false };
    expect(() => nextWorkStart(never, bj("2026-09-29 10:00"))).toThrow(RangeError);
    expect(() => addWorkingDays(never, bj("2026-09-29 10:00"), 1)).toThrow(RangeError);
  });
});

// ---------- 性质（D7 第 10.2 节 P7） ----------
//
// 朴素实现不用 ../time：直接在“北京时间的毫秒数”上按天、按分钟一步一步走，
// 星期几由天数取模得出。随机日历：在周一至周五的底子上随机翻转若干天。

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const OFFSET_MS = 8 * 60 * MINUTE_MS;
/** 2026-01-01 是自 1970-01-01 起的第几天 */
const BASE_DAY = Date.UTC(2026, 0, 1) / DAY_MS;

interface Scenario {
  /** 相对 2026-01-01 的第几天被翻转（工作日变休息，休息日变工作） */
  flipped: number[];
  startMinute: number;
  endMinute: number;
  /** 起算时刻：相对 2026-01-01 00:00（北京时间）的分钟数 */
  fromMinute: number;
}

const scenarios: fc.Arbitrary<Scenario> = fc.record({
  flipped: fc.uniqueArray(fc.integer({ min: 0, max: 120 }), { maxLength: 40 }),
  startMinute: fc.integer({ min: 0, max: 720 }),
  endMinute: fc.integer({ min: 721, max: 1_440 }),
  fromMinute: fc.integer({ min: 0, max: 60 * 1_440 }),
});

/** 第 dayNumber 天（自 1970-01-01 起）是否工作日：周一至周五，翻转的日子取反 */
function naiveIsWorkday(scenario: Scenario, dayNumber: number): boolean {
  const weekday = (((dayNumber + 3) % 7) + 7) % 7; // 0 = 周一
  const base = weekday < 5;
  return scenario.flipped.includes(dayNumber - BASE_DAY) ? !base : base;
}

function calendarOf(scenario: Scenario): WorkCalendar {
  return {
    workStartMinute: scenario.startMinute,
    workEndMinute: scenario.endMinute,
    isWorkday(date) {
      const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
      return naiveIsWorkday(scenario, Date.UTC(year, month - 1, day) / DAY_MS);
    },
  };
}

/** 北京时间的毫秒数（把时刻平移 8 小时后当 UTC 看） */
const localMs = (scenario: Scenario): number => BASE_DAY * DAY_MS + scenario.fromMinute * MINUTE_MS;
const toInstant = (local: number): Date => new Date(local - OFFSET_MS);

function naiveAddWorkingDays(scenario: Scenario, local: number, days: number): number {
  let dayNumber = Math.floor(local / DAY_MS);
  let clock = local - dayNumber * DAY_MS;
  if (!naiveIsWorkday(scenario, dayNumber)) {
    do dayNumber += 1;
    while (!naiveIsWorkday(scenario, dayNumber));
    clock = scenario.startMinute * MINUTE_MS;
  }
  // 逐日累加：每走到一个工作日记一次
  for (let counted = 0; counted < days;) {
    dayNumber += 1;
    if (naiveIsWorkday(scenario, dayNumber)) counted += 1;
  }
  return dayNumber * DAY_MS + clock;
}

function naiveInWorkHours(scenario: Scenario, local: number): boolean {
  const dayNumber = Math.floor(local / DAY_MS);
  const minute = (local - dayNumber * DAY_MS) / MINUTE_MS;
  return (
    naiveIsWorkday(scenario, dayNumber) &&
    minute >= scenario.startMinute &&
    minute < scenario.endMinute
  );
}

function naiveAddWorkingMinutes(scenario: Scenario, local: number, minutes: number): number {
  let cursor = local;
  while (!naiveInWorkHours(scenario, cursor)) cursor += MINUTE_MS;
  // 逐分钟累加：每在工作时段内走一分钟记一次；记满即停，哪怕正好停在下班时刻
  for (let counted = 0; counted < minutes; counted += 1) {
    while (!naiveInWorkHours(scenario, cursor)) cursor += MINUTE_MS;
    cursor += MINUTE_MS;
  }
  return cursor;
}

describe("工作日性质（D7 第 10.2 节 P7）", () => {
  it("addWorkingDays 与逐日累加的朴素实现一致", () => {
    fc.assert(
      fc.property(scenarios, fc.integer({ min: 0, max: 30 }), (scenario, days) => {
        const local = localMs(scenario);
        const actual = addWorkingDays(calendarOf(scenario), toInstant(local), days);
        expect(actual.at.getTime()).toBe(
          toInstant(naiveAddWorkingDays(scenario, local, days)).getTime(),
        );
        expect(actual.usedFallback).toBe(false);
      }),
      runs,
    );
  });

  it(
    "addWorkingMinutes 与逐分钟累加的朴素实现一致；累计出来的工作分钟数恰为所加的数",
    () => {
      fc.assert(
        fc.property(scenarios, fc.integer({ min: 0, max: 3_000 }), (scenario, minutes) => {
          const cal = calendarOf(scenario);
          const from = toInstant(localMs(scenario));
          const actual = addWorkingMinutes(cal, from, minutes);
          expect(actual.at.getTime()).toBe(
            toInstant(naiveAddWorkingMinutes(scenario, localMs(scenario), minutes)).getTime(),
          );
          expect(workingMinutesBetween(cal, from, actual.at).minutes).toBe(minutes);
        }),
        runs,
      );
      // 朴素实现逐分钟走，轮次多时比较慢：超时随轮次放宽
    },
    30_000 + runs.numRuns * 50,
  );

  it("nthWorkdayAfter：结果是工作日，且它与起点之间恰有 n − 1 个工作日", () => {
    fc.assert(
      fc.property(scenarios, fc.integer({ min: 1, max: 30 }), (scenario, n) => {
        const cal = calendarOf(scenario);
        const startDay = BASE_DAY + Math.floor(scenario.fromMinute / 1_440);
        const startDate = new Date(startDay * DAY_MS).toISOString().slice(0, 10);
        const { date } = nthWorkdayAfter(cal, startDate, n);
        const endDay = Date.parse(`${date}T00:00:00Z`) / DAY_MS;
        expect(naiveIsWorkday(scenario, endDay)).toBe(true);
        let between = 0;
        for (let day = startDay + 1; day < endDay; day += 1) {
          if (naiveIsWorkday(scenario, day)) between += 1;
        }
        expect(between).toBe(n - 1);
      }),
      runs,
    );
  });
});
