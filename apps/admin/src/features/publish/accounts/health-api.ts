import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { createPublishSupport, unwrap, type Body } from "../patrol/api";
export type HealthQuery = operations["admin.channelAccount.list"]["parameters"]["query"];
export type HealthScope = operations["admin.channelAccount.summary"]["parameters"]["query"];
export function createHealthApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    ...createPublishSupport(services),
    list: (query: HealthQuery, signal?: AbortSignal) =>
      client.GET("/api/v1/admin/channel-accounts", { params: { query }, signal }).then(unwrap),
    summary: (query: HealthScope, signal?: AbortSignal) =>
      client
        .GET("/api/v1/admin/channel-accounts/summary", { params: { query }, signal })
        .then(unwrap),
    detail: (id: string, signal?: AbortSignal) =>
      client
        .GET("/api/v1/admin/channel-accounts/{channelAccountId}", {
          params: { path: { channelAccountId: id } },
          signal,
        })
        .then(unwrap),
    abnormal: (
      id: string,
      body: Body<"admin.channelAccount.markAbnormal">,
      key: string,
      signal?: AbortSignal,
    ) =>
      client
        .POST("/api/v1/admin/channel-accounts/{channelAccountId}/mark-abnormal", {
          params: { path: { channelAccountId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
  };
}
export type HealthApi = ReturnType<typeof createHealthApi>;
export type HealthDetail = Awaited<ReturnType<HealthApi["detail"]>>;
