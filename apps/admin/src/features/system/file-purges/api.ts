import type { components, operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type FileView = components["schemas"]["AdminFileView"];
export type RunView = components["schemas"]["PurgeRunView"];
export type FileQuery = NonNullable<operations["admin.file.list"]["parameters"]["query"]>;
export type RunQuery = NonNullable<operations["admin.purgeRun.list"]["parameters"]["query"]>;
export class PurgeFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
  }
}
async function unwrap<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  const failure = await readFailure(
    result.error === undefined
      ? result.response
      : new Response(JSON.stringify(result.error), {
          status: result.response.status,
          headers: result.response.headers,
        }),
  );
  throw new PurgeFailure(failure.message, failure.symbol, failure.status, failure.body?.details);
}
export function createPurgeApi({ api }: Pick<AppServices, "api">) {
  const client = api.client;
  return {
    files: (query: FileQuery) =>
      client.GET("/api/v1/admin/files", { params: { query } }).then(unwrap),
    runs: (query: RunQuery) =>
      client.GET("/api/v1/admin/purge-runs", { params: { query } }).then(unwrap),
    restore: (fileId: string, body: components["schemas"]["ReasonRequiredBody"], key: string) =>
      client
        .POST("/api/v1/admin/files/{fileId}/restore", {
          params: { path: { fileId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    erase: (fileId: string, body: components["schemas"]["FileEraseBody"], key: string) =>
      client
        .POST("/api/v1/admin/files/{fileId}/erase", {
          params: { path: { fileId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    approve: (purgeRunId: string, body: components["schemas"]["PurgeApproveBody"], key: string) =>
      client
        .POST("/api/v1/admin/purge-runs/{purgeRunId}/approve", {
          params: { path: { purgeRunId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    reject: (purgeRunId: string, body: components["schemas"]["ReasonRequiredBody"], key: string) =>
      client
        .POST("/api/v1/admin/purge-runs/{purgeRunId}/reject", {
          params: { path: { purgeRunId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
  };
}
export type PurgeApi = ReturnType<typeof createPurgeApi>;
