import { LaunchCalendarSchema, LaunchSubmissionDetailSchema } from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { accessResult } from "../../system/staff-access";

export type CalendarQuery = NonNullable<
  operations["admin.launchCalendar.get"]["parameters"]["query"]
>;
export function createCalendarApi({ api }: Pick<AppServices, "api">) {
  return {
    get: (query: CalendarQuery, signal?: AbortSignal) =>
      api.client
        .GET("/api/v1/admin/launch-calendar", {
          params: { query },
          signal,
        })
        .then(accessResult)
        .then((value) => LaunchCalendarSchema.parse(value)),
    managers: (page: number, pool: boolean, signal?: AbortSignal) =>
      api.client
        .GET("/api/v1/admin/staff", {
          params: {
            query: {
              page,
              pageSize: 100,
              roleKey: "delivery_manager",
              status: "active",
              ...(pool ? { pool: "delivery_manager" } : {}),
            },
          },
          signal,
        })
        .then(accessResult),
    submission: (id: string, signal?: AbortSignal) =>
      api.client
        .GET("/api/v1/admin/launch-submissions/{launchSubmissionId}", {
          params: { path: { launchSubmissionId: id } },
          signal,
        })
        .then(accessResult)
        .then((value) => LaunchSubmissionDetailSchema.parse(value)),
  };
}
export type CalendarApi = ReturnType<typeof createCalendarApi>;
export type CalendarData = Awaited<ReturnType<CalendarApi["get"]>>;
export type CalendarItem = CalendarData["days"][number]["items"][number];
