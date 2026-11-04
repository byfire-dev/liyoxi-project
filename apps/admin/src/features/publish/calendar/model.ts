import { DateSchema, IdSchema } from "@liyoxi/contract";
import { hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import type { CalendarData, CalendarItem } from "./api";

export const CALENDAR_KEY = ["publish", "calendar"] as const;
export const calendarKinds = {
  producing: { label: "制作中", tone: "info" },
  to_launch: { label: "待上线", tone: "warning" },
  verifying: { label: "上线核验", tone: "success" },
  overdue: { label: "已逾期", tone: "danger" },
} as const;
export function beijingDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year").padStart(4, "0")}-${value("month")}-${value("day")}`;
}
export function validId(value: unknown): string | undefined {
  return IdSchema.safeParse(value).success ? (value as string) : undefined;
}
export function calendarSearch(raw: Record<string, unknown>, now = new Date()) {
  const month =
    typeof raw.month === "string" && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(raw.month)
      ? raw.month
      : beijingDate(now).slice(0, 7);
  const date =
    typeof raw.date === "string" &&
    DateSchema.safeParse(raw.date).success &&
    raw.date.startsWith(`${month}-`)
      ? raw.date
      : undefined;
  return { month, date, managerId: validId(raw.managerId) };
}
export type CalendarSearch = ReturnType<typeof calendarSearch>;
export function writeCalendarSearch(search: CalendarSearch): Record<string, string> {
  return {
    month: search.month,
    ...(search.date ? { date: search.date } : {}),
    ...(search.managerId ? { managerId: search.managerId } : {}),
  };
}
export function calendarQuery(search: CalendarSearch) {
  return { month: search.month, ...(search.managerId ? { managerId: search.managerId } : {}) };
}
export function selectedDate(data: CalendarData, requested?: string) {
  return requested && data.workCalendar.days.some((day) => day.date === requested)
    ? requested
    : data.today >= data.from && data.today <= data.to
      ? data.today
      : data.from;
}
export function calendarDays(data: CalendarData) {
  const items = new Map(data.days.map((day) => [day.date, day.items]));
  return data.workCalendar.days.map((day) => ({ ...day, items: items.get(day.date) ?? [] }));
}
export function dayLabel(day: CalendarData["workCalendar"]["days"][number]) {
  if (day.kind === null || day.isWorkday === null) return "缺少日历";
  if (day.kind === "holiday") return day.name ?? "节假日";
  if (day.kind === "adjusted_workday") return `${day.name ? `${day.name} · ` : ""}调休上班`;
  return day.isWorkday ? "工作日" : "休息日";
}
export function verifyingTasks(tasks: CalendarItem["tasks"]) {
  return tasks.filter(
    (task) => task.reviewStatus === "verifying" && task.currentSubmissionId !== null,
  );
}
export function verifyApprovalId(
  detail: {
    launchSubmissionId: string;
    isCurrentRound: boolean;
    approval: { approvalId: string; status: string };
  },
  requested: string,
) {
  if (
    detail.launchSubmissionId !== requested ||
    !detail.isCurrentRound ||
    detail.approval.status !== "pending"
  )
    return null;
  return detail.approval.approvalId;
}
export function managerAccess(access: AccessSnapshot | null) {
  const system = hasModuleLevel(access, "system");
  return {
    allowed:
      system ||
      [
        "merchant.manager.assign",
        "merchant.manager.transfer",
        "service.ticket.assign",
        "service.ticket.transfer",
      ].some((action) => access?.actions.includes(action)),
    pool: !system,
  };
}
