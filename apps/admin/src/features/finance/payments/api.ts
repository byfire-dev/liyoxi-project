import { PaymentTransactionPageSchema, PaymentTransactionSummarySchema } from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";

export async function financeResult<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  const response =
    result.error === undefined
      ? result.response
      : new Response(JSON.stringify(result.error), {
          status: result.response.status,
          headers: result.response.headers,
        });
  const failure = await readFailure(response),
    tail = requestIdTail(failure.requestId);
  // 不把 Provider 原文、响应正文或 schema 校验内容带到财务页。
  throw new Error(`读取失败，请重试${tail ? `（请求编号 ${tail}）` : ""}`);
}
export const financeReadError = "数据暂未能读取，请重试";
export function createPaymentsApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (
      query: operations["admin.paymentTransaction.list"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      client
        .GET("/api/v1/admin/payment-transactions", { params: { query }, signal })
        .then(financeResult)
        .then((data) => PaymentTransactionPageSchema.parse(data)),
    summary: (
      query: operations["admin.paymentTransaction.summary"]["parameters"]["query"],
      signal?: AbortSignal,
    ) =>
      client
        .GET("/api/v1/admin/payment-transactions/summary", { params: { query }, signal })
        .then(financeResult)
        .then((data) => PaymentTransactionSummarySchema.parse(data)),
  };
}
export type PaymentRow = Awaited<
  ReturnType<ReturnType<typeof createPaymentsApi>["list"]>
>["items"][number];
