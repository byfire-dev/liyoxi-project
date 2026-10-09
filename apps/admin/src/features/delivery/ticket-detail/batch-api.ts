import {
  BatchUploadCredentialsSchema,
  UploadBatchDetailSchema,
  UploadBatchItemSchema,
  UploadBatchCommitResultSchema,
  type UploadBatchCreateBody,
  type UploadBatchItemUpdateBody,
} from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";

async function unwrap<T>(result: { data?: { data: T }; response: Response }): Promise<T> {
  if (result.data) return result.data.data;
  const failure = await readFailure(result.response);
  throw new Error(failure.message);
}

/** The eight-route batch protocol stays private to the existing ticket page. */
export function createBatchApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  return {
    create: (body: UploadBatchCreateBody, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/upload-batches", {
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap)
        .then((data) => UploadBatchDetailSchema.parse(data)),
    get: (id: string, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/upload-batches/{uploadBatchId}", {
          params: { path: { uploadBatchId: id } },
          signal,
        })
        .then(unwrap)
        .then((data) => UploadBatchDetailSchema.parse(data)),
    start: (id: string, acceptSequenceSuggestion: boolean, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/upload-batches/{uploadBatchId}/start", {
          params: { path: { uploadBatchId: id } },
          body: { acceptSequenceSuggestion },
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap)
        .then((data) => UploadBatchDetailSchema.parse(data)),
    refresh: (id: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/upload-batches/{uploadBatchId}/refresh-credentials", {
          params: { path: { uploadBatchId: id } },
          body: {},
          signal,
        })
        .then(unwrap)
        .then((data) => BatchUploadCredentialsSchema.parse(data)),
    update: (id: string, body: UploadBatchItemUpdateBody, key: string, signal?: AbortSignal) =>
      c
        .PATCH("/api/v1/admin/upload-batch-items/{uploadBatchItemId}", {
          params: { path: { uploadBatchItemId: id } },
          body,
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap)
        .then((data) => UploadBatchDetailSchema.parse(data)),
    complete: (id: string, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/upload-batch-items/{uploadBatchItemId}/complete", {
          params: { path: { uploadBatchItemId: id } },
          body: {},
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap)
        .then((data) => UploadBatchItemSchema.parse(data)),
    cancel: (id: string, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/upload-batches/{uploadBatchId}/cancel", {
          params: { path: { uploadBatchId: id } },
          body: {},
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap)
        .then((data) => UploadBatchDetailSchema.parse(data)),
    commit: (id: string, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/upload-batches/{uploadBatchId}/commit", {
          params: { path: { uploadBatchId: id } },
          body: {},
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(unwrap)
        .then((data) => UploadBatchCommitResultSchema.parse(data)),
  };
}
export type BatchApi = ReturnType<typeof createBatchApi>;
