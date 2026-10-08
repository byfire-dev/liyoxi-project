// W2-18：实际接线经中央 request；类型取生成的operation，不改现有队列与订阅封装。
import type { operations } from "@liyoxi/contract/types/merchant";
import { ApiError } from "./request";
import type { RequestLayer } from "./request";
import type { ServerCalls } from "./server";

type JsonBody<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
type JsonData<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { "application/json": { data: infer D } } } };
}
  ? D
  : never;
type RawEnvelope =
  operations["m.clientError.create"]["requestBody"]["content"]["application/x-sentry-envelope"];
export function createClientReporting(
  request: RequestLayer["request"],
): Pick<ServerCalls, "reportSubscribeResult" | "sendAnalytics" | "sendClientError"> {
  return {
    reportSubscribeResult: (body, idempotencyKey) =>
      request<JsonData<"m.subscribeResult.create">>("/m/subscribe-results", {
        method: "POST",
        data: body satisfies JsonBody<"m.subscribeResult.create">,
        idempotencyKey,
      }),
    async sendAnalytics(batch) {
      try {
        await request<JsonData<"m.analyticsEvent.batchCreate">>("/m/analytics-events", {
          method: "POST",
          data: batch satisfies JsonBody<"m.analyticsEvent.batchCreate">,
        });
        return "ok";
      } catch (error) {
        // 未配置、4xx、限流与开关关闭丢弃；只网络失败/5xx交回原队列的重试分支。
        return error instanceof ApiError && (error.error === "NETWORK_ERROR" || error.status >= 500)
          ? "retry"
          : "drop";
      }
    },
    sendClientError: (envelope) =>
      request<null>("/m/client-errors", {
        method: "POST",
        data: envelope satisfies RawEnvelope,
        contentType: "application/x-sentry-envelope",
      }),
  };
}
