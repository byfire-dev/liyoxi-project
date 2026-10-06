import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type OrderQuery = NonNullable<operations["admin.order.list"]["parameters"]["query"]>;
export type OrderFilters = NonNullable<operations["admin.order.summary"]["parameters"]["query"]>;
async function unwrap<T>(result: { data?: { data: T }; response: Response }): Promise<T> {
  if (result.data) return result.data.data;
  throw new Error((await readFailure(result.response)).message);
}
export function createOrdersApi(
  services: Pick<AppServices, "api">,
  staffPool?: "delivery_manager",
) {
  const client = services.api.client;
  return {
    list: (query: OrderQuery) =>
      client.GET("/api/v1/admin/orders", { params: { query } }).then(unwrap),
    summary: (query: OrderFilters) =>
      client.GET("/api/v1/admin/orders/summary", { params: { query } }).then(unwrap),
    detail: (orderId: string) =>
      client.GET("/api/v1/admin/orders/{orderId}", { params: { path: { orderId } } }).then(unwrap),
    managers: () =>
      client
        .GET("/api/v1/admin/staff", {
          params: {
            query: {
              roleKey: "delivery_manager",
              status: "active",
              pageSize: 100,
              pool: staffPool,
            },
          },
        })
        .then(unwrap),
  };
}
export type OrdersApi = ReturnType<typeof createOrdersApi>;
export type OrderCard = Awaited<ReturnType<OrdersApi["list"]>>["items"][number];
export type OrderDetail = Awaited<ReturnType<OrdersApi["detail"]>>;
