import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";

/** 订单时间轴允许日历日期、带时区时刻或尚未发生的空值。 */
export function formatOrderTimelineTime(at: string | null): string | undefined {
  if (!at) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(at)
    ? appDateTimeFormat.date(at)
    : appDateTimeFormat.dateTime(at);
}
