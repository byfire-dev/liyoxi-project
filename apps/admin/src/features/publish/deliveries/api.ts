import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type PushBody =
  operations["admin.deliveryTicket.pushPackage"]["requestBody"]["content"]["application/json"];
export class DeliveryFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
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
  if (
    typeof result.error === "object" &&
    result.error &&
    "error" in result.error &&
    "message" in result.error &&
    typeof result.error.error === "string" &&
    typeof result.error.message === "string"
  )
    throw new DeliveryFailure(result.error.message, result.error.error);
  const failure = await readFailure(result.response);
  throw new DeliveryFailure(failure.message, failure.symbol);
}
export function createDeliveriesApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (tab: "delivering" | "delivered_today", q: string | undefined, page: number) =>
      client
        .GET("/api/v1/admin/delivery-tickets", {
          params: { query: { tab, q, page, pageSize: 100, sort: "urgency" } },
        })
        .then(unwrap),
    summary: (q?: string) =>
      client
        .GET("/api/v1/admin/delivery-tickets/summary", { params: { query: { q } } })
        .then(unwrap),
    detail: (id: string) =>
      client
        .GET("/api/v1/admin/delivery-tickets/{deliveryTicketId}", {
          params: { path: { deliveryTicketId: id } },
        })
        .then(unwrap),
    episodes: (id: string) =>
      client
        .GET("/api/v1/admin/delivery-tickets/{deliveryTicketId}/episode-outputs", {
          params: { path: { deliveryTicketId: id } },
        })
        .then(unwrap),
    release: (id: string) =>
      client
        .GET("/api/v1/admin/delivery-releases/{deliveryReleaseId}", {
          params: { path: { deliveryReleaseId: id } },
        })
        .then(unwrap),
    template: () =>
      client
        .GET("/api/v1/admin/checklist-templates", {
          params: { query: { code: "delivery.precheck", status: "active" } },
        })
        .then(unwrap)
        .then((data) => data.items.find((item) => item.code === "delivery.precheck")),
    push: (id: string, body: PushBody, key: string) =>
      client
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/push-package", {
          params: { path: { deliveryTicketId: id } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
  };
}
export type DeliveriesApi = ReturnType<typeof createDeliveriesApi>;
export type DeliveryDetail = Awaited<ReturnType<DeliveriesApi["detail"]>>;
export type EpisodeGrid = Awaited<ReturnType<DeliveriesApi["episodes"]>>;
export type Template = NonNullable<Awaited<ReturnType<DeliveriesApi["template"]>>>;
