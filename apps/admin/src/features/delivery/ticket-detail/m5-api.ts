import { DeliveryTicketDetailSchema } from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";

export type M5Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export class TicketActionFailure extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly tail: string | null = null,
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
  throw new TicketActionFailure(failure.symbol, failure.status, requestIdTail(failure.requestId));
}
export function createM5TicketApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  const ticket = (id: string) => ({ path: { deliveryTicketId: id } });
  const write = (key: string, signal: AbortSignal) => ({
    headers: { "Idempotency-Key": key },
    signal,
  });
  return {
    async get(id: string, signal: AbortSignal) {
      const value = DeliveryTicketDetailSchema.parse(
        await result(
          await c.GET("/api/v1/admin/delivery-tickets/{deliveryTicketId}", {
            params: ticket(id),
            signal,
          }),
        ),
      );
      if (value.deliveryTicketId !== id) throw new TicketActionFailure("RESPONSE_MISMATCH");
      return value;
    },
    activity: (id: string, signal: AbortSignal, cursor?: string) =>
      c
        .GET("/api/v1/admin/delivery-tickets/{deliveryTicketId}/activities", {
          params: { ...ticket(id), query: { cursor, limit: 30 } },
          signal,
        })
        .then(result),
    candidates: (role: "editor" | "publisher", signal: AbortSignal) =>
      c
        .GET("/api/v1/admin/staff", {
          params: { query: { roleKey: role, status: "active", pool: role, pageSize: 100 } },
          signal,
        })
        .then(result),
    openWork: (id: string, signal: AbortSignal) =>
      c
        .GET("/api/v1/admin/staff/{staffId}/open-work", {
          params: { path: { staffId: id } },
          signal,
        })
        .then(result),
    reasons: (signal: AbortSignal) =>
      c
        .GET("/api/v1/admin/dict-items", {
          params: { query: { typeKey: "reissue_reason" } },
          signal,
        })
        .then(result),
    template: (signal: AbortSignal) =>
      c
        .GET("/api/v1/admin/checklist-templates", {
          params: { query: { code: "delivery.precheck", status: "active" } },
          signal,
        })
        .then(result),
    materials: (id: string, signal: AbortSignal) =>
      c
        .GET("/api/v1/admin/delivery-tickets/{deliveryTicketId}/materials", {
          params: ticket(id),
          signal,
        })
        .then(result),
    materialDownload: (
      id: string,
      body: M5Body<"admin.deliveryTicket.material.downloadUrls">,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/materials/download-urls", {
          params: ticket(id),
          body,
          signal,
        })
        .then(result),
    production: (id: string, signal: AbortSignal, page = 1) =>
      c
        .GET("/api/v1/admin/production-records", {
          params: { query: { orderItemId: id, pageSize: 100, page } },
          signal,
        })
        .then(result),
    productionRecord: (orderItemId: string, fileId: string, signal: AbortSignal) =>
      c
        .GET("/api/v1/admin/production-records", {
          params: { query: { orderItemId, fileIds: [fileId], pageSize: 100 } },
          signal,
        })
        .then(result),
    assignEditor: (
      id: string,
      body: M5Body<"admin.deliveryTicket.assignEditor">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/assign-editor", {
          params: ticket(id),
          body,
          ...write(key, signal),
        })
        .then(result),
    assignPublisher: (
      id: string,
      body: M5Body<"admin.deliveryTicket.assignPublisher">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/assign-publisher", {
          params: ticket(id),
          body,
          ...write(key, signal),
        })
        .then(result),
    force: (
      id: string,
      body: M5Body<"admin.deliveryTicket.forceTransition">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/force-transition", {
          params: ticket(id),
          body,
          ...write(key, signal),
        })
        .then(result),
    reevaluate: (id: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/reevaluate", {
          params: ticket(id),
          body: {},
          ...write(key, signal),
        })
        .then(result),
    rework: (
      id: string,
      body: M5Body<"admin.deliveryTicket.rework">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/rework", {
          params: ticket(id),
          body,
          ...write(key, signal),
        })
        .then(result),
    remind: (
      id: string,
      body: M5Body<"admin.deliveryTicket.remind">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/remind", {
          params: ticket(id),
          body,
          ...write(key, signal),
        })
        .then(result),
    reschedule: (
      id: string,
      body: M5Body<"admin.orderItem.rescheduleLaunch">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/order-items/{orderItemId}/reschedule-launch", {
          params: { path: { orderItemId: id } },
          body,
          ...write(key, signal),
        })
        .then(result),
    reissue: (
      id: string,
      body: M5Body<"admin.deliveryTicket.reissue.create">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/reissues", {
          params: ticket(id),
          body,
          ...write(key, signal),
        })
        .then(result),
    cancelReissue: (
      id: string,
      body: M5Body<"admin.reissue.cancel">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/reissues/{reissueId}/cancel", {
          params: { path: { reissueId: id } },
          body,
          ...write(key, signal),
        })
        .then(result),
    publishReissue: (
      id: string,
      body: M5Body<"admin.reissue.publish">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/reissues/{reissueId}/publish", {
          params: { path: { reissueId: id } },
          body,
          ...write(key, signal),
        })
        .then(result),
    markSent: (id: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/samples/{sampleId}/mark-sent", {
          params: { path: { sampleId: id } },
          body: {},
          ...write(key, signal),
        })
        .then(result),
    feedback: (
      id: string,
      body: M5Body<"admin.sample.requestChange">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/samples/{sampleId}/request-change", {
          params: { path: { sampleId: id } },
          body,
          ...write(key, signal),
        })
        .then(result),
    normalize: (
      id: string,
      body: M5Body<"admin.productionRecord.normalize">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/production-records/{productionRecordId}/normalize", {
          params: { path: { productionRecordId: id } },
          body,
          ...write(key, signal),
        })
        .then(result),
    recheck: (id: string, key: string, signal: AbortSignal) =>
      c
        .POST("/api/v1/admin/production-records/{productionRecordId}/recheck", {
          params: { path: { productionRecordId: id } },
          body: {},
          ...write(key, signal),
        })
        .then(result),
    restamp: (
      id: string,
      body: M5Body<"admin.productionRecord.restamp">,
      key: string,
      signal: AbortSignal,
    ) =>
      c
        .POST("/api/v1/admin/production-records/{productionRecordId}/restamp", {
          params: { path: { productionRecordId: id } },
          body,
          ...write(key, signal),
        })
        .then(result),
  };
}
export type M5TicketApi = ReturnType<typeof createM5TicketApi>;
export type M5Ticket = Awaited<ReturnType<M5TicketApi["get"]>>;
