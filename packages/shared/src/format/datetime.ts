// 时间、日期、区间、相对时间的显示格式（规范 第 7 节）。金额、积分、增减在 format/money（W0-11）。
//
// 页面与服务端用 appDateTimeFormat：它绑定应用时区（北京时间），偏移取自“时区”子路径 ../time（W0-11），
// 本文件不另写时区常量。createDateTimeFormat(偏移) 留给用例与确实要按别的偏移出字的地方。
// 时区：结果只取决于入参与偏移，不读运行机器的时区，不用 Intl。
// “现在”由调用方传入（业务时间用注入的时钟），本文件不取当前时间。

import { APP_UTC_OFFSET_MINUTES, parseLocalDate } from "../time/index.js";

/** 时刻：Date、毫秒时间戳，或带时区的 ISO 8601 字符串（以 Z 或 ±hh:mm 结尾） */
export type Instant = Date | number | string;
/** “哪一天”：YYYY-MM-DD，已经是应用时区的日历日期，不再换算。不是真实存在的日期即报错 */
export type Day = string;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface DateTimeFormat {
  /** 默认：MM-DD HH:mm → “09-28 10:12” */
  dateTime(at: Instant): string;
  /** 跨年或需要存档的（合同、发票、公告）：YYYY-MM-DD HH:mm */
  dateTimeFull(at: Instant): string;
  /** 有效期只写日期：YYYY-MM-DD → “2027-12-31” */
  date(at: Instant | Day): string;
  /** 句中的日期，数字两侧留空格 → “10 月 12 日” */
  dateInSentence(at: Instant | Day): string;
  /** 日期区间用“至” → “09-13 至 10-12”；两头不在同一年时写全 YYYY-MM-DD */
  dateRange(from: Instant | Day, to: Instant | Day): string;
  /** 当日截止写 24:00：次日 00:00 写成前一天的 24:00 → “10-12 24:00”；其余时刻同 dateTime */
  deadline(at: Instant): string;
  /** 相对时间：一分钟内“刚刚”；当天“今天 HH:mm”；其余同 dateTime，不在同一年时写全 */
  relative(at: Instant, now: Instant): string;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** 长得像“哪一天”的字符串：交给时区子路径的 parseLocalDate 拆，月、日出了范围由它报错 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_MS = 60_000;

const two = (value: number): string => String(value).padStart(2, "0");

function toEpochMs(at: Instant): number {
  let ms: number;
  if (typeof at === "number") ms = at;
  else if (at instanceof Date) ms = at.getTime();
  else if (ISO_WITH_ZONE.test(at)) ms = Date.parse(at);
  else throw new RangeError(`时刻字符串须带时区（以 Z 或 ±hh:mm 结尾），收到 ${at}`);
  if (!Number.isFinite(ms)) throw new RangeError(`不是有效的时刻：${String(at)}`);
  return ms;
}

/** 按固定偏移换成墙上时间。把偏移加进时间戳后只读 UTC 的各个部件，所以与机器时区无关 */
function wallClock(epochMs: number, utcOffsetMinutes: number): WallClock {
  const shifted = new Date(epochMs + utcOffsetMinutes * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

const ymd = (c: WallClock): string => `${c.year}-${two(c.month)}-${two(c.day)}`;
const md = (c: WallClock): string => `${two(c.month)}-${two(c.day)}`;
const hm = (c: WallClock): string => `${two(c.hour)}:${two(c.minute)}`;

/**
 * 按给定的 UTC 偏移（分钟）出一组格式化函数。偏移须是整数分钟。
 * 应用里不直接调它：用下面绑定了应用时区的 appDateTimeFormat，不在各处写偏移。
 */
export function createDateTimeFormat(utcOffsetMinutes: number): DateTimeFormat {
  if (!Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 18 * 60) {
    throw new RangeError(`UTC 偏移须是分钟数，收到 ${utcOffsetMinutes}`);
  }
  const clock = (at: Instant): WallClock => wallClock(toEpochMs(at), utcOffsetMinutes);
  const dayOf = (at: Instant | Day): WallClock => {
    if (typeof at !== "string" || !DAY.test(at)) return clock(at);
    return { ...parseLocalDate(at), hour: 0, minute: 0 };
  };
  const dateTime = (at: Instant): string => `${md(clock(at))} ${hm(clock(at))}`;
  const dateTimeFull = (at: Instant): string => `${ymd(clock(at))} ${hm(clock(at))}`;

  return {
    dateTime,
    dateTimeFull,
    date: (at) => ymd(dayOf(at)),
    dateInSentence: (at) => `${dayOf(at).month} 月 ${dayOf(at).day} 日`,
    dateRange: (from, to) => {
      const [start, end] = [dayOf(from), dayOf(to)];
      return start.year === end.year
        ? `${md(start)} 至 ${md(end)}`
        : `${ymd(start)} 至 ${ymd(end)}`;
    },
    deadline: (at) => {
      const ms = toEpochMs(at);
      const c = wallClock(ms, utcOffsetMinutes);
      const atMidnight = c.hour === 0 && c.minute === 0 && ms % MINUTE_MS === 0;
      return atMidnight ? `${md(wallClock(ms - MINUTE_MS, utcOffsetMinutes))} 24:00` : dateTime(at);
    },
    relative: (at, now) => {
      const [then, current] = [clock(at), clock(now)];
      if (Math.abs(toEpochMs(now) - toEpochMs(at)) < MINUTE_MS) return "刚刚";
      if (ymd(then) === ymd(current)) return `今天 ${hm(then)}`;
      return then.year === current.year ? dateTime(at) : dateTimeFull(at);
    },
  };
}

/**
 * 应用时区（北京时间）下的一组格式化函数：页面与服务端显示时间都用它。
 * 偏移是“时区”子路径的 APP_UTC_OFFSET_MINUTES，与按“日”的业务规则（calendarDate、dayRange）同一个来源。
 */
export const appDateTimeFormat: DateTimeFormat = createDateTimeFormat(APP_UTC_OFFSET_MINUTES);
