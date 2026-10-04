import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { APP_UTC_OFFSET_MINUTES, calendarDate } from "../time/index.js";
import { appDateTimeFormat, createDateTimeFormat } from "./datetime.js";

// 规范的例子都对绑定了应用时区的出口断言：页面与服务端用的就是它
const format = appDateTimeFormat;

describe("规范 第 7 节的例子", () => {
  it("默认 MM-DD HH:mm → 09-28 10:12", () => {
    expect(format.dateTime("2026-09-28T10:12:00+08:00")).toBe("09-28 10:12");
    expect(format.dateTime("2026-09-28T02:12:00Z")).toBe("09-28 10:12");
  });

  it("跨年或存档用 YYYY-MM-DD HH:mm", () => {
    expect(format.dateTimeFull("2026-09-28T02:12:00Z")).toBe("2026-09-28 10:12");
  });

  it("有效期只写日期 → 2027-12-31", () => {
    expect(format.date("2027-12-31T15:59:59Z")).toBe("2027-12-31");
    expect(format.date("2027-12-31")).toBe("2027-12-31");
  });

  it("句中的日期，数字两侧留空格 → 10 月 12 日", () => {
    expect(format.dateInSentence("2026-10-12")).toBe("10 月 12 日");
    expect(`将于 ${format.dateInSentence("2026-10-11T16:00:00Z")} 清零`).toBe(
      "将于 10 月 12 日 清零",
    );
  });

  it("日期区间用“至” → 09-13 至 10-12", () => {
    expect(format.dateRange("2026-09-13", "2026-10-12")).toBe("09-13 至 10-12");
    expect(format.dateRange("2026-09-12T16:00:00Z", "2026-10-12T15:59:00Z")).toBe("09-13 至 10-12");
    expect(format.dateRange("2026-12-13", "2027-01-12")).toBe("2026-12-13 至 2027-01-12");
  });

  it("当日截止写 24:00 → 10-12 24:00", () => {
    // 周期左闭右开：10-12 的截止时刻就是 10-13 00:00
    expect(format.deadline("2026-10-13T00:00:00+08:00")).toBe("10-12 24:00");
    expect(format.deadline("2026-10-12T18:00:00+08:00")).toBe("10-12 18:00");
    expect(format.deadline("2027-01-01T00:00:00+08:00")).toBe("12-31 24:00");
  });

  it("相对时间：当天写“今天 HH:mm”，一分钟内写“刚刚”", () => {
    const now = "2026-09-28T10:12:30+08:00";
    expect(format.relative("2026-09-28T09:12:00+08:00", now)).toBe("今天 09:12");
    expect(format.relative("2026-09-28T10:12:00+08:00", now)).toBe("刚刚");
    expect(format.relative("2026-09-27T23:59:00+08:00", now)).toBe("09-27 23:59");
    expect(format.relative("2025-12-31T23:59:00+08:00", now)).toBe("2025-12-31 23:59");
  });
});

describe("绑定应用时区的出口", () => {
  const INSTANTS = [
    "2026-09-28T02:12:00Z",
    "2026-10-12T15:59:59.999Z", // 北京时间 10-12 23:59:59.999
    "2026-10-12T16:00:00Z", // 北京时间 10-13 00:00
    "2026-12-31T16:00:00Z", // 北京时间次年 01-01 00:00
    "2024-02-28T16:00:00Z", // 北京时间闰日 02-29 00:00
  ];

  it("偏移取自“时区”子路径：与按 APP_UTC_OFFSET_MINUTES 现造的一组逐项相同", () => {
    const expected = createDateTimeFormat(APP_UTC_OFFSET_MINUTES);
    const now = "2026-10-12T16:00:30Z";
    for (const at of INSTANTS) {
      expect(appDateTimeFormat.dateTime(at)).toBe(expected.dateTime(at));
      expect(appDateTimeFormat.dateTimeFull(at)).toBe(expected.dateTimeFull(at));
      expect(appDateTimeFormat.date(at)).toBe(expected.date(at));
      expect(appDateTimeFormat.dateInSentence(at)).toBe(expected.dateInSentence(at));
      expect(appDateTimeFormat.dateRange(at, now)).toBe(expected.dateRange(at, now));
      expect(appDateTimeFormat.deadline(at)).toBe(expected.deadline(at));
      expect(appDateTimeFormat.relative(at, now)).toBe(expected.relative(at, now));
    }
  });

  it("“哪一天”与时区子路径的 calendarDate 一致：显示的日期就是业务规则算的那一天", () => {
    for (const at of INSTANTS) {
      expect(appDateTimeFormat.date(at)).toBe(calendarDate(new Date(at)));
    }
    expect(appDateTimeFormat.date("2026-10-12T15:59:59.999Z")).toBe("2026-10-12");
    expect(appDateTimeFormat.date("2026-10-12T16:00:00Z")).toBe("2026-10-13");
  });

  it("换了偏移就不是它：绑定的确实是应用时区，不是 UTC", () => {
    expect(appDateTimeFormat.dateTime("2026-09-28T02:12:00Z")).toBe("09-28 10:12");
    expect(createDateTimeFormat(0).dateTime("2026-09-28T02:12:00Z")).toBe("09-28 02:12");
  });

  it("源码里不另写时区常量：没有写死的偏移与时区名", () => {
    const source = readFileSync(fileURLToPath(new URL("./datetime.ts", import.meta.url)), "utf8");
    expect(source).toContain('from "../time/index.js"');
    expect(source).toContain("createDateTimeFormat(APP_UTC_OFFSET_MINUTES)");
    expect(source).not.toMatch(/\b480\b|\b8\s*\*\s*60\b|Asia\/|UTC\+8|GMT\+8/);
  });
});

describe("入参", () => {
  it("Date、毫秒时间戳、带时区的字符串结果相同", () => {
    const iso = "2026-09-28T02:12:00.000Z";
    expect(format.dateTime(new Date(iso))).toBe("09-28 10:12");
    expect(format.dateTime(Date.parse(iso))).toBe("09-28 10:12");
  });

  it("不带时区的时刻字符串、无效时刻、非法偏移都报错", () => {
    expect(() => format.dateTime("2026-09-28T10:12:00")).toThrow(RangeError);
    expect(() => format.dateTime("2026-09-28 10:12")).toThrow(RangeError);
    expect(() => format.dateTime(Number.NaN)).toThrow(RangeError);
    expect(() => createDateTimeFormat(8)).not.toThrow();
    expect(() => createDateTimeFormat(480.5)).toThrow(RangeError);
  });

  it("“哪一天”不是真实存在的日期即报错，不原样写出去", () => {
    expect(() => format.date("2027-13-45")).toThrow(RangeError);
    expect(() => format.dateInSentence("2026-00-00")).toThrow(RangeError);
    expect(() => format.dateRange("2026-09-31", "2026-10-12")).toThrow(RangeError);
    expect(() => format.date("2026-02-29")).toThrow(RangeError);
    expect(format.date("2028-02-29")).toBe("2028-02-29");
  });

  it("换一个偏移，同一时刻的写法跟着变", () => {
    expect(createDateTimeFormat(0).dateTime("2026-09-28T02:12:00Z")).toBe("09-28 02:12");
    expect(createDateTimeFormat(-300).date("2026-09-28T02:12:00Z")).toBe("2026-09-27");
  });
});

describe("结果不随运行机器的时区变化", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  const snapshot = (): string[] => [
    format.dateTime("2026-09-28T02:12:00Z"),
    format.dateTimeFull("2026-12-31T16:30:00Z"),
    format.date("2027-12-31T15:59:59Z"),
    format.dateInSentence("2026-10-11T16:00:00Z"),
    format.dateRange("2026-09-12T16:00:00Z", "2026-10-12T15:59:00Z"),
    format.deadline("2026-10-12T16:00:00Z"),
    format.relative("2026-09-28T01:12:00Z", "2026-09-28T02:12:30Z"),
    format.relative(new Date("2026-09-27T15:59:00Z"), new Date("2026-09-28T02:12:30Z")),
  ];

  it("在几个进程时区下各跑一次，逐项相同", () => {
    const offsets = new Set<number>();
    const results = ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata"].map(
      (tz) => {
        process.env.TZ = tz;
        // 先确认换时区真的生效了：同一时刻在各时区的本地偏移不同
        offsets.add(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset());
        return snapshot();
      },
    );
    expect(offsets.size).toBe(4);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toEqual([
      "09-28 10:12",
      "2027-01-01 00:30",
      "2027-12-31",
      "10 月 12 日",
      "09-13 至 10-12",
      "10-12 24:00",
      "今天 09:12",
      "09-27 23:59",
    ]);
  });
});
