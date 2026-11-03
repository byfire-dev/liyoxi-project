import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";

export type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export type PatrolQuery = operations["admin.patrolTask.list"]["parameters"]["query"];
export type PatrolScope = operations["admin.patrolTask.summary"]["parameters"]["query"];
export type NormalBody = Body<"admin.patrolTask.markNormal">;
export type AbnormalBody = Body<"admin.patrolTask.markAbnormal">;
export class PublishFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export async function unwrap<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  const body = result.error;
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string" &&
    "message" in body &&
    typeof body.message === "string"
  )
    throw new PublishFailure(
      body.message,
      body.error,
      "details" in body ? body.details : undefined,
    );
  const failure = await readFailure(result.response);
  throw new PublishFailure(failure.message, failure.symbol, failure.body?.details);
}
export function createPublishSupport(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    template: (code: string) =>
      client
        .GET("/api/v1/admin/checklist-templates", { params: { query: { code, status: "active" } } })
        .then(unwrap)
        .then((data) => data.items.find((item) => item.code === code)),
    reasons: (typeKey: string, scene?: string) =>
      client
        .GET("/api/v1/admin/dict-items", { params: { query: { typeKey, scene } } })
        .then(unwrap)
        .then((data) => data.items.filter((item) => item.isEnabled)),
    evidence: (fileId: string) =>
      client
        .POST("/api/v1/admin/files/{fileId}/download-urls", {
          params: { path: { fileId } },
          body: { disposition: "inline" },
        })
        .then(unwrap),
  };
}
export type Template = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createPublishSupport>["template"]>>
>;
export function createPatrolApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    ...createPublishSupport(services),
    list: (query: PatrolQuery, signal?: AbortSignal) =>
      client.GET("/api/v1/admin/patrol-tasks", { params: { query }, signal }).then(unwrap),
    summary: (query: PatrolScope, signal?: AbortSignal) =>
      client.GET("/api/v1/admin/patrol-tasks/summary", { params: { query }, signal }).then(unwrap),
    detail: (id: string, signal?: AbortSignal) =>
      client
        .GET("/api/v1/admin/patrol-tasks/{patrolTaskId}", {
          params: { path: { patrolTaskId: id } },
          signal,
        })
        .then(unwrap),
    create: (body: Body<"admin.patrolTask.create">, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/patrol-tasks", { body, headers: { "Idempotency-Key": key }, signal })
        .then(unwrap),
    normal: (id: string, body: NormalBody, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/patrol-tasks/{patrolTaskId}/mark-normal", {
          params: { path: { patrolTaskId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
    abnormal: (id: string, body: AbnormalBody, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/patrol-tasks/{patrolTaskId}/mark-abnormal", {
          params: { path: { patrolTaskId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
    recover: (id: string, body: NormalBody, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/patrol-tasks/{patrolTaskId}/recover", {
          params: { path: { patrolTaskId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
    remind: (id: string, key: string, signal?: AbortSignal) =>
      client
        .POST("/api/v1/admin/patrol-tasks/{patrolTaskId}/remind", {
          params: { path: { patrolTaskId: id } },
          body: {},
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap),
  };
}
export type PatrolApi = ReturnType<typeof createPatrolApi>;
export type PatrolDetail = Awaited<ReturnType<PatrolApi["detail"]>>;
