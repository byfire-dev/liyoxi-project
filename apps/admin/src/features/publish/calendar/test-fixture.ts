import { vi } from "vitest";
import { createAdminApi } from "../../../lib/api";
import type { CalendarData, CalendarItem } from "./api";
export const id = (n: number) => `0199e187-e72a-7000-8000-${String(n).padStart(12, "0")}`;
export const account = {
  channelAccountId: id(2),
  platform: "douyin" as const,
  accountName: "虚构测试账号",
  accountUid: "fictional-account",
  status: "available" as const,
};
export const task: CalendarItem["tasks"][number] = {
  launchTaskId: id(3),
  platform: "douyin",
  account,
  reviewStatus: "verifying",
  isLive: false,
  currentRoundNo: 1,
  verifiedEpisodeCount: 0,
  firstLaunchDate: null,
  isOverdue: false,
  currentSubmissionId: id(4),
  latestPassedSubmissionId: null,
};
export function calendarFixture(): CalendarData {
  return {
    from: "2026-10-01",
    to: "2026-10-03",
    today: "2026-10-02",
    stats: { total: 8, producing: 2, toLaunch: 2, verifying: 3, overdue: 1 },
    days: [],
    total: 8,
    isTruncated: true,
    workCalendar: {
      calendarVersion: 3,
      years: [{ year: 2026, importedAt: null }],
      days: [
        { date: "2026-10-01", kind: "holiday", isWorkday: false, name: "国庆节" },
        { date: "2026-10-02", kind: null, isWorkday: null, name: null },
        { date: "2026-10-03", kind: "adjusted_workday", isWorkday: true, name: "调休" },
      ],
    },
  };
}
export function transport(
  reply: (request: Request, index: number) => Response | Promise<Response>,
) {
  const requests: Request[] = [];
  const handlers = {
    redirectToLogin: vi.fn(),
    stepUp: vi.fn(async () => true),
    refreshAccess: vi.fn(),
    invalidateQueries: vi.fn(),
    notify: vi.fn(),
    showBlocked: vi.fn(),
    buildMismatch: vi.fn(),
  };
  const api = createAdminApi({
    baseUrl: "https://fictional-admin.test",
    build: "w608",
    handlers,
    fetch: async (request) => {
      requests.push(request);
      return reply(request, requests.length);
    },
  });
  return { api, requests, handlers };
}
export const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
export const denied = () =>
  new Response(
    JSON.stringify({ code: 40301, error: "PERMISSION_DENIED", message: "无权访问当前事项" }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
