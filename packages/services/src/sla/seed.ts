// sla 的种子（W0-21）：工作日历（01 分组 第 2.7 节）。一天一行：先按“周一至周五工作、周末休息”铺满全年，
// 再用当年的放假安排盖上放假日与调休上班日。有放假安排的年份之外，把下一年也铺上底（只有平日与周末）：
// 下一年的安排公布后由后台导入。没有才插：导入过、改过的日子不动。批次号都是 1（表为空时的初始批次）。
// 日期按北京时间的“日”存成 date；这里一律用 UTC 零点的 Date 表示某一天，不经过本机时区。
import type { EnumValue, WORK_CALENDAR_DAY_KIND } from "@liyoxi/contract";

import { defineSeed, insertMissing } from "../kernel/index.js";

export type CalendarDayKind = EnumValue<typeof WORK_CALENDAR_DAY_KIND>;

export interface HolidayArrangement {
  readonly year: number;
  /** 出处 */
  readonly source: string;
  /** 放假：节日名、起止日（含），写成 MM-DD */
  readonly holidays: readonly (readonly [name: string, from: string, to: string])[];
  /** 调休上班：调休名、日期 MM-DD（都落在周末） */
  readonly adjustedWorkdays: readonly (readonly [name: string, day: string])[];
}

/** 已公布的年度放假安排。新的一年公布后可以往这里加一年，也可以直接在后台导入 */
export const HOLIDAY_ARRANGEMENTS: readonly HolidayArrangement[] = [
  {
    year: 2026,
    source: "国务院办公厅关于 2026 年部分节假日安排的通知",
    holidays: [
      ["元旦", "01-01", "01-03"],
      ["春节", "02-15", "02-23"],
      ["清明节", "04-04", "04-06"],
      ["劳动节", "05-01", "05-05"],
      ["端午节", "06-19", "06-21"],
      ["中秋节", "09-25", "09-27"],
      ["国庆节", "10-01", "10-07"],
    ],
    adjustedWorkdays: [
      ["元旦调休", "01-04"],
      ["春节调休", "02-14"],
      ["春节调休", "02-28"],
      ["劳动节调休", "05-09"],
      ["国庆节调休", "09-20"],
      ["国庆节调休", "10-10"],
    ],
  },
];

export interface CalendarDaySeed {
  /** YYYY-MM-DD */
  readonly day: string;
  readonly kind: CalendarDayKind;
  readonly note: string | null;
}

const DAY_MS = 86_400_000;
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const utcDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** 一年的日历：铺底，再盖上这一年的放假安排（没有安排的年份只有铺底） */
export function calendarDaysOf(
  year: number,
  arrangement: HolidayArrangement | undefined = HOLIDAY_ARRANGEMENTS.find(
    (item) => item.year === year,
  ),
): CalendarDaySeed[] {
  const marks = new Map<string, { kind: CalendarDayKind; note: string }>();
  for (const [name, from, to] of arrangement?.holidays ?? []) {
    const end = utcDay(`${year}-${to}`).getTime();
    for (let at = utcDay(`${year}-${from}`).getTime(); at <= end; at += DAY_MS) {
      marks.set(isoDay(new Date(at)), { kind: "holiday", note: name });
    }
  }
  for (const [name, day] of arrangement?.adjustedWorkdays ?? []) {
    marks.set(`${year}-${day}`, { kind: "adjusted_workday", note: name });
  }
  const days: CalendarDaySeed[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let at = Date.UTC(year, 0, 1); at < end; at += DAY_MS) {
    const date = new Date(at);
    const day = isoDay(date);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const mark = marks.get(day);
    days.push({
      day,
      kind: mark?.kind ?? (weekend ? "weekend" : "weekday"),
      note: mark?.note ?? null,
    });
  }
  return days;
}

/** 播哪几年：有放假安排的年份，加上最后一年的下一年 */
export function seededCalendarYears(): number[] {
  const years = HOLIDAY_ARRANGEMENTS.map((item) => item.year);
  return [...years, Math.max(...years) + 1];
}

export const seed = defineSeed("sla", async (tx, { now }) => {
  const rows = seededCalendarYears().flatMap((year) => calendarDaysOf(year));
  return [
    await insertMissing({
      table: "work_calendar_day",
      rows,
      keyOf: (row) => row.day,
      existingKeys: async () =>
        (
          await tx.workCalendarDay.findMany({
            where: {
              day: { gte: utcDay(rows[0]?.day as string), lte: utcDay(rows.at(-1)?.day as string) },
            },
            select: { day: true },
          })
        ).map((row) => isoDay(row.day)),
      insert: (missing) =>
        tx.workCalendarDay.createMany({
          data: missing.map((row) => ({
            day: utcDay(row.day),
            isWorkday: row.kind === "weekday" || row.kind === "adjusted_workday",
            kind: row.kind,
            note: row.note,
            calendarVersion: 1,
            createdAt: now,
            updatedAt: now,
          })),
        }),
    }),
  ];
});
