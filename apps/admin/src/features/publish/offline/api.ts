import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { createPublishSupport, unwrap, type Body } from "../patrol/api";
export type OfflineQuery = operations["admin.takedownTask.list"]["parameters"]["query"];
export type OfflineScope = operations["admin.takedownTask.summary"]["parameters"]["query"];
export type CheckBody = Body<"admin.takedownTask.check">;
export type BatchBody = Body<"admin.takedownTask.batchCheck">;
export function createOfflineApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    ...createPublishSupport(services),
    list: (query: OfflineQuery, signal?: AbortSignal) =>
      client.GET("/api/v1/admin/takedown-tasks", { params: { query }, signal }).then(unwrap),
    summary: (query: OfflineScope, signal?: AbortSignal) =>
      client
        .GET("/api/v1/admin/takedown-tasks/summary", { params: { query }, signal })
        .then(unwrap),
    detail: (id: string, signal?: AbortSignal) =>
      client
        .GET("/api/v1/admin/takedown-tasks/{takedownTaskId}", {
          params: { path: { takedownTaskId: id } },
          signal,
        })
        .then(unwrap),
    check: (id: string, body: CheckBody, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/takedown-tasks/{takedownTaskId}/check", {
          params: { path: { takedownTaskId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
    batch: (body: BatchBody, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/takedown-tasks/check", {
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
    online: (
      id: string,
      body: Body<"admin.takedownTask.markOnline">,
      key: string,
      signal?: AbortSignal,
    ) =>
      client
        .POST("/api/v1/admin/takedown-tasks/{takedownTaskId}/mark-online", {
          params: { path: { takedownTaskId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
    escalate: (
      id: string,
      body: Body<"admin.takedownTask.escalate">,
      key: string,
      signal?: AbortSignal,
    ) =>
      client
        .POST("/api/v1/admin/takedown-tasks/{takedownTaskId}/escalate", {
          params: { path: { takedownTaskId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
    breach: (id: string, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/takedown-tasks/{takedownTaskId}/send-breach-notice", {
          params: { path: { takedownTaskId: id } },
          body: {},
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
  };
}
export type OfflineApi = ReturnType<typeof createOfflineApi>;
export type OfflineDetail = Awaited<ReturnType<OfflineApi["detail"]>>;
export type OfflineRow = Awaited<ReturnType<OfflineApi["list"]>>["items"][number];
