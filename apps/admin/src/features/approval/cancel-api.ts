import {
  CancelRequestDetailSchema,
  CancelRequestListSchema,
  CancelRequestSummarySchema,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../app/services";
import { readFailure } from "../../lib/api-errors";

export class CancelFailure extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly explicitBody = true,
  ) {
    super(code);
  }
}
async function result<T>(value: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (value.data) return value.data.data;
  const response =
    value.error === undefined
      ? value.response
      : new Response(JSON.stringify(value.error), {
          status: value.response.status,
          headers: value.response.headers,
        });
  const failure = await readFailure(response);
  throw new CancelFailure(failure.symbol, failure.status, failure.body !== null);
}
type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export type CancelCommand = {
  [A in "approve" | "reject" | "withdraw" | "void" | "execute"]: {
    action: A;
    body: Body<`admin.cancelRequest.${A}`>;
  };
}["approve" | "reject" | "withdraw" | "void" | "execute"];
export function createCancelApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (
      query: operations["admin.cancelRequest.list"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      client
        .GET("/api/v1/admin/cancel-requests", { params: { query }, signal })
        .then(result)
        .then((data) => CancelRequestListSchema.parse(data)),
    summary: (
      query: operations["admin.cancelRequest.summary"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      client
        .GET("/api/v1/admin/cancel-requests/summary", { params: { query }, signal })
        .then(result)
        .then((data) => CancelRequestSummarySchema.parse(data)),
    async get(cancelRequestId: string, signal?: AbortSignal) {
      const detail = CancelRequestDetailSchema.parse(
        await client
          .GET("/api/v1/admin/cancel-requests/{cancelRequestId}", {
            params: { path: { cancelRequestId } },
            signal,
          })
          .then(result),
      );
      if (detail.cancelRequestId !== cancelRequestId) throw new CancelFailure("RESPONSE_MISMATCH");
      return detail;
    },
    async write(id: string, command: CancelCommand, key: string, signal: AbortSignal) {
      const options = {
        params: { path: { cancelRequestId: id } },
        headers: { "Idempotency-Key": key },
        signal,
      };
      // 固定 typed 路径；不执行审批详情中的任意 operation 字符串。成功响应后仅 GET 对账。
      switch (command.action) {
        case "approve":
          await client
            .POST("/api/v1/admin/cancel-requests/{cancelRequestId}/approve", {
              ...options,
              body: command.body,
            })
            .then(result);
          break;
        case "reject":
          await client
            .POST("/api/v1/admin/cancel-requests/{cancelRequestId}/reject", {
              ...options,
              body: command.body,
            })
            .then(result);
          break;
        case "withdraw":
          await client
            .POST("/api/v1/admin/cancel-requests/{cancelRequestId}/withdraw", {
              ...options,
              body: command.body,
            })
            .then(result);
          break;
        case "void":
          await client
            .POST("/api/v1/admin/cancel-requests/{cancelRequestId}/void", {
              ...options,
              body: command.body,
            })
            .then(result);
          break;
        case "execute":
          await client
            .POST("/api/v1/admin/cancel-requests/{cancelRequestId}/execute", {
              ...options,
              body: command.body,
            })
            .then(result);
          break;
      }
    },
  };
}
export type CancelDetail = Awaited<ReturnType<ReturnType<typeof createCancelApi>["get"]>>;
