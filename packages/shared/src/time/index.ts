// 子路径 @liyoxi/shared/time：应用时区、“哪一天”、某日的起止时刻、日期加减。
//
// 业务时区固定北京时间（UTC+8，无夏令时；D1 第 3.1 节）。所有按“日”的规则都按它算，
// 不看运行机器的时区。实现只用固定偏移与整数运算：不用 Intl 的时区数据（小程序基础库
// 对它支持不稳），不用 Date 的本地时间方法，不用 BigInt（小程序可引）。
//
// 口径借自参考工程 packages/shared/src/time.ts 与 constants.ts（calendarDate、dayRange、
// 两个常量），实现改为固定偏移。

/** 应用时区名。算日期不靠它，靠下面的固定偏移；两者一致由测试钉住 */
export const APP_TIMEZONE = "Asia/Shanghai";

/** 应用时区相对 UTC 的分钟偏移。中国自 1991 年起不实行夏令时，所以是常量 */
export const APP_UTC_OFFSET_MINUTES = 480;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1_440;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;
const OFFSET_MS = APP_UTC_OFFSET_MINUTES * MS_PER_MINUTE;

/** “哪一天”：`YYYY-MM-DD`，北京时间的日历日期（约定 第 5 节 C35） */
export type LocalDate = string;

export interface LocalDateParts {
  year: number;
  /** 1 到 12 */
  month: number;
  /** 1 到 31 */
  day: number;
}

export interface LocalDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_MINUTE = /^(\d{2}):(\d{2})$/;

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const pad = (value: number, width: number): string => String(value).padStart(width, "0");

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 某年某月有几天；month 为 1 到 12 */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`日期：年月不合法 ${String(year)}-${String(month)}`);
  }
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** 公历日期 → 自 1970-01-01 起的天数。纯整数运算，不经过 Date */
function toDayNumber({ year, month, day }: LocalDateParts): number {
  const y = month <= 2 ? year - 1 : year;
  const era = floorDiv(y, 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = floorDiv(153 * (month > 2 ? month - 3 : month + 9) + 2, 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** 自 1970-01-01 起的天数 → 公历日期 */
function fromDayNumber(dayNumber: number): LocalDateParts {
  const z = dayNumber + 719_468;
  const era = floorDiv(z, 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = floorDiv(
    dayOfEra - floorDiv(dayOfEra, 1_460) + floorDiv(dayOfEra, 36_524) - floorDiv(dayOfEra, 146_096),
    365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100));
  const monthIndex = floorDiv(5 * dayOfYear + 2, 153);
  const day = dayOfYear - floorDiv(153 * monthIndex + 2, 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** 拆开 `YYYY-MM-DD`；格式不对或不是真实存在的日期即抛错 */
export function parseLocalDate(date: LocalDate): LocalDateParts {
  const match = typeof date === "string" ? LOCAL_DATE.exec(date) : null;
  if (!match) throw new RangeError(`日期：不是 YYYY-MM-DD：${String(date)}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`日期：不存在的日期 ${date}`);
  }
  return { year, month, day };
}

export function isLocalDate(value: string): boolean {
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

/** 年月日 → `YYYY-MM-DD`；不是真实存在的日期即抛错 */
export function formatLocalDate(year: number, month: number, day: number): LocalDate {
  const valid =
    Number.isInteger(year) && year >= 1 && year <= 9_999 && Number.isInteger(day) && day >= 1;
  if (!valid || day > daysInMonth(year, month)) {
    throw new RangeError(`日期：不存在的日期 ${String(year)}-${String(month)}-${String(day)}`);
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function shiftedMs(at: Date): number {
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new RangeError("时间：无效的时刻");
  return ms + OFFSET_MS;
}

/** 某个时刻在北京时间下的年月日时分秒 */
export function toLocalParts(at: Date): LocalDateTimeParts {
  const ms = shiftedMs(at);
  const dayNumber = floorDiv(ms, MS_PER_DAY);
  const msOfDay = ms - dayNumber * MS_PER_DAY;
  return {
    ...fromDayNumber(dayNumber),
    hour: floorDiv(msOfDay, 3_600_000),
    minute: floorDiv(msOfDay, MS_PER_MINUTE) % 60,
    second: floorDiv(msOfDay, 1_000) % 60,
    millisecond: msOfDay % 1_000,
  };
}

/** “哪一天”：某个时刻在北京时间下的日历日期 */
export function calendarDate(at: Date): LocalDate {
  const { year, month, day } = toLocalParts(at);
  return formatLocalDate(year, month, day);
}

/** 某个时刻距北京时间当日零点的分钟数（0 到 1439），秒以下舍去 */
export function minuteOfDay(at: Date): number {
  const ms = shiftedMs(at);
  return floorDiv(ms - floorDiv(ms, MS_PER_DAY) * MS_PER_DAY, MS_PER_MINUTE);
}

/** 某日 00:00（北京时间）对应的时刻 */
export function startOfDay(date: LocalDate): Date {
  return new Date(toDayNumber(parseLocalDate(date)) * MS_PER_DAY - OFFSET_MS);
}

/** 某日 24:00（北京时间）对应的时刻，即次日 00:00。“到期日 24:00”用它 */
export function endOfDay(date: LocalDate): Date {
  return new Date(startOfDay(date).getTime() + MS_PER_DAY);
}

/** 某日的起止时刻，左闭右开：[当日 00:00, 次日 00:00) */
export function dayRange(date: LocalDate): { start: Date; end: Date } {
  return { start: startOfDay(date), end: endOfDay(date) };
}

/** 某日的某个钟点对应的时刻；minute 是距零点的分钟数，0 到 1440（1440 即 24:00） */
export function atMinuteOfDay(date: LocalDate, minute: number): Date {
  if (!Number.isInteger(minute) || minute < 0 || minute > MINUTES_PER_DAY) {
    throw new RangeError(
      `时间：距零点的分钟数须在 0 到 ${MINUTES_PER_DAY} 之间，收到 ${String(minute)}`,
    );
  }
  return new Date(startOfDay(date).getTime() + minute * MS_PER_MINUTE);
}

/** 日期加减若干天 */
export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days))
    throw new RangeError(`日期：天数必须是整数，收到 ${String(days)}`);
  const { year, month, day } = fromDayNumber(toDayNumber(parseLocalDate(date)) + days);
  return formatLocalDate(year, month, day);
}

/** 两个日期相差几天：later − earlier，可为负 */
export function diffDays(later: LocalDate, earlier: LocalDate): number {
  return toDayNumber(parseLocalDate(later)) - toDayNumber(parseLocalDate(earlier));
}

/** 星期几：1 = 周一 … 7 = 周日 */
export function dayOfWeek(date: LocalDate): number {
  const dayNumber = toDayNumber(parseLocalDate(date));
  // 1970-01-01 是周四
  return ((((dayNumber + 3) % 7) + 7) % 7) + 1;
}

/** `HH:mm` → 距零点的分钟数；允许 `24:00` */
export function parseHm(text: string): number {
  const match = typeof text === "string" ? HOUR_MINUTE.exec(text) : null;
  const hour = match ? Number(match[1]) : -1;
  const minute = match ? Number(match[2]) : -1;
  if (hour < 0 || minute > 59 || hour * 60 + minute > MINUTES_PER_DAY) {
    throw new RangeError(`时间：不是 HH:mm：${String(text)}`);
  }
  return hour * 60 + minute;
}
