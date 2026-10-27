import {
  PointPackAdminListSchema,
  PointPackRowSchema,
  PointPackSummarySchema,
} from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { billingResult } from "../plans/api";
import type { Body } from "../plans/model";
export function createPointPacksApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  return {
    list: (isListed?: "true" | "false", signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/point-packs", { params: { query: { isListed } }, signal })
        .then(billingResult)
        .then((v) => PointPackAdminListSchema.parse(v)),
    summary: (signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/point-packs/summary", { signal })
        .then(billingResult)
        .then((v) => PointPackSummarySchema.parse(v)),
    create: (body: Body<"admin.pointPack.create">, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/point-packs", { body, headers: { "Idempotency-Key": key }, signal })
        .then(billingResult)
        .then((v) => PointPackRowSchema.parse(v)),
    update: (
      pointPackId: string,
      body: Body<"admin.pointPack.update">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .PATCH("/api/v1/admin/point-packs/{pointPackId}", {
          params: { path: { pointPackId } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PointPackRowSchema.parse(v)),
    shelve: (pointPackId: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/point-packs/{pointPackId}/shelve", {
          params: { path: { pointPackId } },
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PointPackRowSchema.parse(v)),
    delist: (pointPackId: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/point-packs/{pointPackId}/delist", {
          params: { path: { pointPackId } },
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(billingResult)
        .then((v) => PointPackRowSchema.parse(v)),
  };
}
export type PointPacksApi = ReturnType<typeof createPointPacksApi>;
export type PointPack = Awaited<ReturnType<PointPacksApi["list"]>>["items"][number];
