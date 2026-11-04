import { DateSchema, FollowUpCreateBodySchema } from "@liyoxi/contract";
import { readTableSearch } from "../../../lib/table-search";
import { validId } from "../calendar/model";
import type { TrackFilters, TrackItem } from "./api";
export const OVERDUE_KEY = ["publish", "overdue"] as const;
export function overdueSearch(raw: Record<string, unknown>) {
  const table = readTableSearch(raw),
    n = Number(raw.days);
  return {
    tab:
      raw.tab === "upcoming"
        ? ("upcoming" as const)
        : raw.tab === "all"
          ? ("all" as const)
          : ("overdue" as const),
    days: Number.isInteger(n) && n >= 1 && n <= 30 ? n : 7,
    page: table.page,
    pageSize: table.pageSize,
    q: typeof raw.q === "string" ? raw.q.trim().slice(0, 64) || undefined : undefined,
    managerId: validId(raw.managerId),
    deliveryTicketId: validId(raw.deliveryTicketId),
    orderItemId: validId(raw.orderItemId),
    readyOnly: raw.readyOnly === true || raw.readyOnly === "true",
    id: validId(raw.id),
  };
}
export type OverdueSearch = ReturnType<typeof overdueSearch>;
export function writeOverdueSearch(
  search: OverdueSearch,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined),
  ) as Record<string, string | number | boolean>;
}
export function trackFilters(search: OverdueSearch): TrackFilters {
  return {
    days: search.days,
    managerId: search.managerId,
    deliveryTicketId: search.deliveryTicketId,
    orderItemId: search.orderItemId,
    readyOnly: search.readyOnly,
    q: search.q,
  };
}
export function trackQuery(search: OverdueSearch) {
  return { ...trackFilters(search), tab: search.tab, page: search.page, pageSize: search.pageSize };
}
export function overdueLabel(row: Pick<TrackItem, "overdue" | "isDelivered" | "daysUntilLaunch">) {
  if (row.overdue)
    return `${row.overdue.reason === "merchant" ? "商家未按期上线" : "成片晚交"} · ${row.overdue.days} 天`;
  if (row.daysUntilLaunch !== null)
    return `${row.isDelivered ? "成片已交付" : "成片未交付"} · ${row.daysUntilLaunch === 0 ? "今天上线" : `距上线 ${row.daysUntilLaunch} 天`}`;
  return row.isDelivered ? "成片已交付" : "成片未交付";
}
export function followBody(id: string, content: string, nextDate: string, now = new Date()) {
  if (nextDate && !DateSchema.safeParse(nextDate).success)
    throw new Error("请选择有效的下次跟进日期");
  const nextFollowAt = nextDate ? `${nextDate}T09:00:00+08:00` : undefined;
  if (nextFollowAt && Date.parse(nextFollowAt) <= now.getTime())
    throw new Error("下次跟进时间须晚于现在（所选日期北京时间 09:00）");
  const parsed = FollowUpCreateBodySchema.safeParse({
    subjectType: "order_item",
    subjectId: id,
    content: content.trim(),
    ...(nextFollowAt ? { nextFollowAt } : {}),
  });
  if (!parsed.success) throw new Error("请填写 1–200 字跟进内容");
  return parsed.data;
}
export function canRemind(row: Pick<TrackItem, "actions" | "isRemindedToday">) {
  return row.actions.includes("remind") && !row.isRemindedToday;
}
