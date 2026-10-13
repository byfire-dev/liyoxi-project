import type { components, operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type TimerView = components["schemas"]["TimerView"];
export type OutboxView = components["schemas"]["OutboxDeliveryView"];
export type WebhookView = components["schemas"]["WebhookEventView"];
export type MediaView = components["schemas"]["MediaJobView"];
export type MediaQuery = NonNullable<operations["admin.mediaJob.list"]["parameters"]["query"]>;
export type TimerQuery = NonNullable<operations["admin.timer.list"]["parameters"]["query"]>;
export type OutboxQuery = NonNullable<
  operations["admin.outboxDelivery.list"]["parameters"]["query"]
>;
export type WebhookQuery = NonNullable<
  operations["admin.webhookEvent.list"]["parameters"]["query"]
>;
export class FlowOpsFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
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
  // openapi-fetch 已消费错误响应体；采用它实际解析的 error 保留正式符号。
  const failure = await readFailure(
    result.error === undefined
      ? result.response
      : new Response(JSON.stringify(result.error), {
          status: result.response.status,
          headers: result.response.headers,
        }),
  );
  throw new FlowOpsFailure(failure.message, failure.symbol, failure.status);
}
export function createFlowOpsApi({ api }: Pick<AppServices, "api">) {
  const client = api.client;
  return {
    media: (query: MediaQuery) =>
      client.GET("/api/v1/admin/media-jobs", { params: { query } }).then(unwrap),
    retryMedia: (
      mediaJobId: string,
      body: components["schemas"]["MediaJobNoteBody"],
      key: string,
    ) =>
      client
        .POST("/api/v1/admin/media-jobs/{mediaJobId}/retry", {
          params: { path: { mediaJobId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    timers: (query: TimerQuery) =>
      client.GET("/api/v1/admin/timers", { params: { query } }).then(unwrap),
    outbox: (query: OutboxQuery) =>
      client.GET("/api/v1/admin/outbox-deliveries", { params: { query } }).then(unwrap),
    webhooks: (query: WebhookQuery) =>
      client.GET("/api/v1/admin/webhook-events", { params: { query } }).then(unwrap),
    reschedule: (timerId: string, body: components["schemas"]["FlowOpsNoteBody"], key: string) =>
      client
        .POST("/api/v1/admin/timers/{timerId}/reschedule", {
          params: { path: { timerId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    cancel: (timerId: string, body: components["schemas"]["TimerCancelBody"], key: string) =>
      client
        .POST("/api/v1/admin/timers/{timerId}/cancel", {
          params: { path: { timerId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    retryOutbox: (
      outboxEventId: string,
      body: components["schemas"]["OutboxRetryBody"],
      key: string,
    ) =>
      client
        .POST("/api/v1/admin/outbox-events/{outboxEventId}/retry", {
          params: { path: { outboxEventId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    retryWebhook: (
      webhookEventId: string,
      body: components["schemas"]["FlowOpsNoteBody"],
      key: string,
    ) =>
      client
        .POST("/api/v1/admin/webhook-events/{webhookEventId}/retry", {
          params: { path: { webhookEventId } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
  };
}
export type FlowOpsApi = ReturnType<typeof createFlowOpsApi>;
