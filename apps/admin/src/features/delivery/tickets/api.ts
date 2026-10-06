import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type TicketQuery = NonNullable<
  operations["admin.deliveryTicket.list"]["parameters"]["query"]
>;
export type TicketFilters = NonNullable<
  operations["admin.deliveryTicket.summary"]["parameters"]["query"]
>;
export type AssignBody =
  operations["admin.deliveryTicket.assignManager"]["requestBody"]["content"]["application/json"];
export class TicketFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
async function unwrap<T>(result: { data?: { data: T }; response: Response }): Promise<T> {
  if (result.data) return result.data.data;
  const error = await readFailure(result.response);
  throw new TicketFailure(error.message, error.body?.error);
}
export function createTicketsApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (query: TicketQuery) =>
      client.GET("/api/v1/admin/delivery-tickets", { params: { query } }).then(unwrap),
    summary: (query: TicketFilters) =>
      client.GET("/api/v1/admin/delivery-tickets/summary", { params: { query } }).then(unwrap),
    managers: () =>
      client
        .GET("/api/v1/admin/staff", {
          params: { query: { roleKey: "delivery_manager", status: "active", pageSize: 100 } },
        })
        .then(unwrap),
    assign: (id: string, body: AssignBody, key: string) =>
      client
        .POST("/api/v1/admin/delivery-tickets/{deliveryTicketId}/assign-manager", {
          params: { path: { deliveryTicketId: id } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
  };
}
export type TicketsApi = ReturnType<typeof createTicketsApi>;
export type TicketCard = Awaited<ReturnType<TicketsApi["list"]>>["items"][number];
