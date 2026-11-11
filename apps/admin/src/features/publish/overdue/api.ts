import {
  AdminRemindResultSchema,
  FollowUpItemSchema,
  FollowUpPageSchema,
  LaunchTrackPageSchema,
  LaunchTrackSummarySchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { accessResult } from "../../system/staff-access";
export type TrackQuery = NonNullable<operations["admin.launchTask.list"]["parameters"]["query"]>;
export type TrackFilters = NonNullable<
  operations["admin.launchTask.summary"]["parameters"]["query"]
>;
export type FollowBody =
  operations["admin.followUp.create"]["requestBody"]["content"]["application/json"];
export function createOverdueApi({ api }: Pick<AppServices, "api">) {
  const c = api.client;
  return {
    list: (query: TrackQuery, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/launch-tasks", { params: { query }, signal })
        .then(accessResult)
        .then((value) => LaunchTrackPageSchema.parse(value)),
    summary: (query: TrackFilters, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/launch-tasks/summary", { params: { query }, signal })
        .then(accessResult)
        .then((value) => LaunchTrackSummarySchema.parse(value)),
    follows: (id: string, page: number, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/follow-ups", {
          params: { query: { subjectType: "order_item", subjectId: id, page, pageSize: 20 } },
          signal,
        })
        .then(accessResult)
        .then((value) => FollowUpPageSchema.parse(value)),
    follow: (body: FollowBody, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/follow-ups", { body, signal, headers: { "Idempotency-Key": key } })
        .then(accessResult)
        .then((value) => FollowUpItemSchema.parse(value)),
    remind: (id: string, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/remind", {
          params: { path: { deliveryTicketId: id } },
          body: { scene: "golive" },
          signal,
          headers: { "Idempotency-Key": key },
        })
        .then(accessResult)
        .then((value) => AdminRemindResultSchema.parse(value)),
  };
}
export type OverdueApi = ReturnType<typeof createOverdueApi>;
export type TrackItem = Awaited<ReturnType<OverdueApi["list"]>>["items"][number];
