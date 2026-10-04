// 子路径 @liyoxi/shared/period：锚定日、周期起止、各月发放日、发放计划、升级时所处的位置。
//
// 锚定日规则（03 第 2.3 节；D1 第 3.2 节）：
//   锚定日   = 开通当天是几号；连续续费沿用，过期后重新开通时重置
//   边界(k)  = 起始月往后数 k 个月，取 min(锚定日, 该月最后一天)
//   N 个月的周期 = [边界(0), 边界(N))；止日（含）= 边界(N) 的前一天
//   第 i 个月的发放日 = 边界(i)
// 每个边界都从起始月直接算，不在上一个边界上累加，所以不会漂移。
//
// 日期都是北京时间的“哪一天”（YYYY-MM-DD）。不读库、不取当前时间。

import { splitEvenly } from "../alloc/index.js";
import { addDays, daysInMonth, diffDays, formatLocalDate, parseLocalDate } from "../time/index.js";
import type { LocalDate } from "../time/index.js";

/** 一个订阅周期的日期。字段与 subscription_term 同义 */
export interface TermDates {
  /** 起始日（含） */
  startDate: LocalDate;
  /** 锚定日，1 到 31 */
  anchorDay: number;
  /** 购买的月数，不小于 1 */
  months: number;
  /** 止日（含）。含补偿延长：延长只把它往后推，不改边界 */
  endDate: LocalDate;
}

function assertAnchorDay(anchorDay: number): void {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError(`周期：锚定日须在 1 到 31 之间，收到 ${String(anchorDay)}`);
  }
}

function assertMonths(months: number): void {
  if (!Number.isSafeInteger(months) || months < 1) {
    throw new RangeError(`周期：月数必须是正整数，收到 ${String(months)}`);
  }
}

/** 锚定日 = 开通当天是几号 */
export function anchorDayOf(startDate: LocalDate): number {
  return parseLocalDate(startDate).day;
}

/** 边界(k)：起始月往后数 k 个月的那个月里，取 min(锚定日, 该月最后一天) */
export function boundary(startDate: LocalDate, anchorDay: number, k: number): LocalDate {
  assertAnchorDay(anchorDay);
  if (!Number.isSafeInteger(k) || k < 0) {
    throw new RangeError(`周期：边界序号必须是非负整数，收到 ${String(k)}`);
  }
  const start = parseLocalDate(startDate);
  const monthIndex = start.year * 12 + (start.month - 1) + k;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return formatLocalDate(year, month, Math.min(anchorDay, daysInMonth(year, month)));
}

/**
 * 起始日必须落在锚定日上（= 边界(0)）。规则以此为前提；起始日不在锚定日上的周期
 * （补偿延长之后再续接）规则没有定义，这里不猜，直接抛错，由调用方显式给出锚定日。
 */
function assertOnAnchor(startDate: LocalDate, anchorDay: number): void {
  if (boundary(startDate, anchorDay, 0) !== startDate) {
    throw new RangeError(`周期：起始日 ${startDate} 不在锚定日 ${anchorDay} 上`);
  }
}

function assertTerm(term: TermDates): void {
  assertMonths(term.months);
  assertOnAnchor(term.startDate, term.anchorDay);
  if (diffDays(term.endDate, term.startDate) < 0) {
    throw new RangeError(`周期：止日 ${term.endDate} 早于起始日 ${term.startDate}`);
  }
}

/**
 * 从起始日起 months 个月的周期。新开通与过期后重新开通不传锚定日（取起始日是几号）；
 * 续接时传上一期的锚定日。
 */
export function termDates(
  startDate: LocalDate,
  months: number,
  anchorDay: number = anchorDayOf(startDate),
): TermDates {
  assertMonths(months);
  assertOnAnchor(startDate, anchorDay);
  return {
    startDate,
    anchorDay,
    months,
    endDate: addDays(boundary(startDate, anchorDay, months), -1),
  };
}

/** 连续续费：从上一期止日的次日接续，锚定日沿用 */
export function renewTerm(previous: TermDates, months: number): TermDates {
  return termDates(addDays(previous.endDate, 1), months, previous.anchorDay);
}

/** 各月发放日：第 i 个月（i 从 0 起）= 边界(i)，共 months 个 */
export function grantDates(term: TermDates): LocalDate[] {
  assertTerm(term);
  const dates: LocalDate[] = [];
  for (let i = 0; i < term.months; i += 1) dates.push(boundary(term.startDate, term.anchorDay, i));
  return dates;
}

export interface GrantScheduleRow {
  /** 月序号，从 0 起 */
  monthNo: number;
  /** 应发日期 */
  dueDate: LocalDate;
  /** 该月应发积分 */
  points: number;
  /** 该月分摊的套餐款（分） */
  valueFen: number;
}

/**
 * 月度发放计划：周期创建时一次生成 months 行。每行积分相同；
 * 成本 = 周期实付 ÷ 月数向下取整，尾差放最后一个月（07 分组 第 2.11 节）。
 */
export function grantSchedule(
  term: TermDates,
  input: { monthlyPoints: number; payFen: number },
): GrantScheduleRow[] {
  if (!Number.isSafeInteger(input.monthlyPoints) || input.monthlyPoints < 1) {
    throw new RangeError(`周期：每月积分必须是正整数，收到 ${String(input.monthlyPoints)}`);
  }
  const values = splitEvenly(input.payFen, term.months);
  return grantDates(term).map((dueDate, monthNo) => ({
    monthNo,
    dueDate,
    points: input.monthlyPoints,
    valueFen: values[monthNo] ?? 0,
  }));
}

/**
 * 某一天落在周期的第几个月（从 0 起）。补偿延长出来的尾段并入最后一个月，所以封顶为 months − 1。
 * 这一天不在 [起始日, 止日] 内即抛错。
 */
export function monthIndexOf(term: TermDates, date: LocalDate): number {
  assertTerm(term);
  if (diffDays(date, term.startDate) < 0 || diffDays(term.endDate, date) < 0) {
    throw new RangeError(`周期：${date} 不在 ${term.startDate} 至 ${term.endDate} 之内`);
  }
  let index = 0;
  while (
    index < term.months - 1 &&
    diffDays(date, boundary(term.startDate, term.anchorDay, index + 1)) >= 0
  ) {
    index += 1;
  }
  return index;
}

export interface UpgradePosition {
  /** 今天所在的月序，0 到 months − 1 */
  monthIndex: number;
  /** 本计费月剩余天数：本月最后一天 − 今天，当天不计，按基准天数封顶 */
  remainingDays: number;
  /** 其后已预付的整月数 = months − 1 − monthIndex */
  remainingFullMonths: number;
}

/**
 * 升级时处在周期的什么位置（03 第 2.7 节；D1 第 6.5 节）。
 * 本计费月最后一天 = 下一个边界的前一天；最后一个月取周期止日（含延长）。
 * 基准天数是参数 prorationBaseDays，由调用方传入。
 */
export function upgradePosition(
  term: TermDates,
  today: LocalDate,
  baseDays: number,
): UpgradePosition {
  if (!Number.isSafeInteger(baseDays) || baseDays < 1) {
    throw new RangeError(`周期：基准天数必须是正整数，收到 ${String(baseDays)}`);
  }
  const monthIndex = monthIndexOf(term, today);
  const isLastMonth = monthIndex === term.months - 1;
  const monthEnd = isLastMonth
    ? term.endDate
    : addDays(boundary(term.startDate, term.anchorDay, monthIndex + 1), -1);
  return {
    monthIndex,
    remainingDays: Math.min(Math.max(diffDays(monthEnd, today), 0), baseDays),
    remainingFullMonths: term.months - 1 - monthIndex,
  };
}
