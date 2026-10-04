// 本文件另由 tz-process.test.ts 在两个不同的进程时区下各跑一次：结果不得随运行机器的时区变化。
// 时区与日界的用例借自参考工程 packages/shared/src/shared.test.ts，含“偏移常量与时区名一致”的断言。

import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import {
  APP_TIMEZONE,
  APP_UTC_OFFSET_MINUTES,
  addDays,
  atMinuteOfDay,
  calendarDate,
  dayOfWeek,
  dayRange,
  daysInMonth,
  diffDays,
  endOfDay,
  formatLocalDate,
  isLeapYear,
  isLocalDate,
  minuteOfDay,
  parseHm,
  parseLocalDate,
  startOfDay,
  toLocalParts,
} from "./index.js";

const runs = { numRuns: inject("fcRuns"), seed: inject("fcSeed") };

/** 用 Intl 的时区数据算北京时间的各部分。只在测试里用：拿它校对固定偏移的实现 */
function partsByIntl(at: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const result: Record<string, number> = {};
  for (const part of parts) result[part.type] = Number(part.value);
  return result;
}

describe("进程时区探针", () => {
  const expected = process.env.LYX_TZ_PROBE_OFFSET;

  it.skipIf(expected === undefined)("本进程的时区确实是父进程指定的那个", () => {
    // 2026-01-15 当地正午的 UTC 偏移（分钟，西正东负）；父进程按时区给出期望值
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(Number(expected));
  });
});

describe("“哪一天”：calendarDate", () => {
  it("北京时间 23:59:59.999 与次日 00:00:00.000 分属两天", () => {
    expect(calendarDate(new Date("2026-10-12T15:59:59.999Z"))).toBe("2026-10-12");
    expect(calendarDate(new Date("2026-10-12T16:00:00.000Z"))).toBe("2026-10-13");
  });

  it("按北京时间取日期：UTC 09-01 20:00 是北京时间 09-02 04:00", () => {
    expect(calendarDate(new Date("2026-09-01T20:00:00Z"))).toBe("2026-09-02");
  });

  it("跨年与闰日", () => {
    expect(calendarDate(new Date("2026-12-31T16:00:00Z"))).toBe("2027-01-01");
    expect(calendarDate(new Date("2028-02-28T16:00:00Z"))).toBe("2028-02-29");
    expect(calendarDate(new Date("2027-02-28T16:00:00Z"))).toBe("2027-03-01");
  });

  it("1970 年以前的时刻也按 +8 算", () => {
    expect(calendarDate(new Date("1969-12-31T15:59:59.999Z"))).toBe("1969-12-31");
    expect(calendarDate(new Date("1969-12-31T16:00:00.000Z"))).toBe("1970-01-01");
  });

  it("无效的时刻抛错", () => {
    expect(() => calendarDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("某日的起止时刻", () => {
  it("dayRange 覆盖北京时间一整天，左闭右开", () => {
    const { start, end } = dayRange("2026-09-02");
    expect(start.toISOString()).toBe("2026-09-01T16:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-02T16:00:00.000Z");
    expect(calendarDate(start)).toBe("2026-09-02");
    expect(calendarDate(new Date(end.getTime() - 1))).toBe("2026-09-02");
    expect(calendarDate(end)).toBe("2026-09-03");
  });

  it("“到期日 24:00”等于次日 00:00", () => {
    expect(endOfDay("2026-10-12").getTime()).toBe(startOfDay("2026-10-13").getTime());
    expect(endOfDay("2026-10-12").toISOString()).toBe("2026-10-12T16:00:00.000Z");
    expect(atMinuteOfDay("2026-10-12", 1_440).getTime()).toBe(endOfDay("2026-10-12").getTime());
  });

  it("某日某个钟点；距零点的分钟数", () => {
    const at = atMinuteOfDay("2026-09-30", 8 * 60 + 15);
    expect(at.toISOString()).toBe("2026-09-30T00:15:00.000Z");
    expect(minuteOfDay(at)).toBe(495);
    expect(minuteOfDay(new Date("2026-09-30T15:59:59.999Z"))).toBe(1_439);
    expect(minuteOfDay(new Date("2026-09-30T16:00:00.000Z"))).toBe(0);
    expect(() => atMinuteOfDay("2026-09-30", 1_441)).toThrow(RangeError);
    expect(() => atMinuteOfDay("2026-09-30", -1)).toThrow(RangeError);
  });

  it("toLocalParts 给出北京时间的年月日时分秒", () => {
    expect(toLocalParts(new Date("2026-09-28T02:12:34.567Z"))).toEqual({
      year: 2026,
      month: 9,
      day: 28,
      hour: 10,
      minute: 12,
      second: 34,
      millisecond: 567,
    });
  });
});

describe("应用时区常量", () => {
  it("固定偏移是 +480 分钟，时区名是 Asia/Shanghai", () => {
    expect(APP_UTC_OFFSET_MINUTES).toBe(480);
    expect(APP_TIMEZONE).toBe("Asia/Shanghai");
  });

  // 小程序判断“今天”用的是固定偏移（基础库的 Intl 时区支持不稳）。
  // 这里拿 Intl 的时区数据校一遍：改了时区名而忘了改偏移，这条会红。
  it("偏移常量与时区名一致（全年任取几天）", () => {
    for (const iso of ["2026-01-15T00:00:00Z", "2026-07-15T00:00:00Z", "2026-11-01T00:00:00Z"]) {
      const at = new Date(iso);
      const intl = partsByIntl(at);
      const asUtc = Date.UTC(
        intl.year ?? 0,
        (intl.month ?? 0) - 1,
        intl.day ?? 0,
        intl.hour ?? 0,
        intl.minute ?? 0,
        intl.second ?? 0,
      );
      expect((asUtc - at.getTime()) / 60_000).toBe(APP_UTC_OFFSET_MINUTES);
    }
  });

  it("性质：1992 年以后的任意时刻，固定偏移算出的年月日时分秒与 Intl 的时区数据一致", () => {
    const instants = fc.date({
      min: new Date("1992-01-01T00:00:00Z"),
      max: new Date("2100-01-01T00:00:00Z"),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(instants, (at) => {
        const local = toLocalParts(at);
        const intl = partsByIntl(at);
        expect([
          local.year,
          local.month,
          local.day,
          local.hour,
          local.minute,
          local.second,
        ]).toEqual([intl.year, intl.month, intl.day, intl.hour, intl.minute, intl.second]);
      }),
      runs,
    );
  });
});

describe("日期的解析与加减", () => {
  it.each(["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-2-3"])(
    "不存在或写法不对的日期抛错：%s",
    (text) => {
      expect(() => parseLocalDate(text)).toThrow(RangeError);
      expect(isLocalDate(text)).toBe(false);
    },
  );

  it.each(["20260203", "2026/02/03", " 2026-02-03", "2026-02-03T00:00", ""])(
    "不是 YYYY-MM-DD 抛错：%j",
    (text) => {
      expect(() => parseLocalDate(text)).toThrow(RangeError);
    },
  );

  it("闰年：2028、2000 是，2027、2100 不是", () => {
    expect([2028, 2000, 2027, 2100].map(isLeapYear)).toEqual([true, true, false, false]);
    expect(parseLocalDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(() => daysInMonth(2027, 13)).toThrow(RangeError);
    expect(() => formatLocalDate(2027, 2, 29)).toThrow(RangeError);
  });

  it("加减天数与相差天数", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-10-13", -1)).toBe("2026-10-12");
    expect(addDays("2027-12-31", 1)).toBe("2028-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(diffDays("2026-10-12", "2026-09-30")).toBe(12);
    expect(diffDays("2026-09-30", "2026-10-12")).toBe(-12);
    expect(() => addDays("2026-09-30", 0.5)).toThrow(RangeError);
  });

  it("星期几：1 = 周一 … 7 = 周日", () => {
    // 2026-09-30 是周三；2026-10-10 是周六；2026-10-11 是周日
    expect(["2026-09-30", "2026-10-10", "2026-10-11", "2026-10-12"].map(dayOfWeek)).toEqual([
      3, 6, 7, 1,
    ]);
    expect(dayOfWeek("1970-01-01")).toBe(4);
    expect(dayOfWeek("1969-12-28")).toBe(7);
  });

  it("HH:mm 转成距零点的分钟数", () => {
    expect(parseHm("09:00")).toBe(540);
    expect(parseHm("18:00")).toBe(1_080);
    expect(parseHm("24:00")).toBe(1_440);
    for (const bad of ["9:00", "24:01", "12:60", "0900", ""]) {
      expect(() => parseHm(bad)).toThrow(RangeError);
    }
  });

  it("性质：日期运算与 Date.UTC 的日历一致，加减可逆", () => {
    const anyDate = fc
      .tuple(fc.integer({ min: 1600, max: 2400 }), fc.integer({ min: 1, max: 12 }), fc.nat())
      .map(([year, month, seed]) => ({ year, month, day: (seed % daysInMonth(year, month)) + 1 }));
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -40_000, max: 40_000 }), ({ year, month, day }, n) => {
        const date = formatLocalDate(year, month, day);
        const utc = new Date(Date.UTC(year, month - 1, day));
        expect(diffDays(date, "1970-01-01")).toBe(utc.getTime() / 86_400_000);
        expect(dayOfWeek(date)).toBe(utc.getUTCDay() === 0 ? 7 : utc.getUTCDay());

        const moved = addDays(date, n);
        const movedUtc = new Date(utc.getTime() + n * 86_400_000);
        expect(parseLocalDate(moved)).toEqual({
          year: movedUtc.getUTCFullYear(),
          month: movedUtc.getUTCMonth() + 1,
          day: movedUtc.getUTCDate(),
        });
        expect(diffDays(moved, date)).toBe(n);
        expect(addDays(moved, -n)).toBe(date);
        expect(calendarDate(startOfDay(date))).toBe(date);
      }),
      runs,
    );
  });
});
