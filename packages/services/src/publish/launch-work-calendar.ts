import type { LaunchCalendarSchema, z } from "@liyoxi/contract";
import type { Clock, Tx } from "../kernel/index.js";
import { readCalendarYear } from "../sla/index.js";

type WorkCalendar = z.infer<typeof LaunchCalendarSchema>["workCalendar"];

/** 请求范围来自 launchCalendarBounds；日历缺行与年度未导入分别保留，不计算假期。 */
export async function readLaunchWorkCalendar(
  tx: Tx,
  clock: Clock,
  from: string,
  to: string,
): Promise<WorkCalendar> {
  const calendars = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    // 公口的共享导入锁持有到原事务结束，跨年仍读取同一全表版本。
    calendars.push(await readCalendarYear(tx, clock, { year, includeAllDays: true }));
  }
  const actualDays = new Map(
    calendars.flatMap((calendar) => (calendar.days ?? []).map((day) => [day.date, day] as const)),
  );
  const names = new Map(
    calendars.flatMap((calendar) => calendar.items.map((item) => [item.date, item.note] as const)),
  );
  const days: WorkCalendar["days"] = [];
  const last = Date.parse(`${to}T00:00:00.000Z`);
  // 只枚举已校验的日期标签，不用星期推算事实；保留旧 month 接受的 0000 年。
  for (let at = Date.parse(`${from}T00:00:00.000Z`); at <= last; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10),
      actual = actualDays.get(date);
    days.push({
      date,
      kind: actual?.kind ?? null,
      isWorkday: actual?.isWorkday ?? null,
      name:
        actual?.kind === "holiday" || actual?.kind === "adjusted_workday"
          ? (names.get(date) ?? null)
          : null,
    });
  }
  return {
    calendarVersion: calendars[0]!.calendarVersion,
    years: calendars.map(({ year, importedAt }) => ({ year, importedAt })),
    days,
  };
}
