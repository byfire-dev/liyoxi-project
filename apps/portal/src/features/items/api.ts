import type { components } from "@liyoxi/contract/types/portal";
import type { PortalClient } from "../../lib/api";

export type OrderPage = components["schemas"]["PortalOrderItemPage"];
export type AdPage = components["schemas"]["PortalAdPage"];

export function createItemsApi(client: PortalClient) {
  return {
    orders: (cursor: string | undefined, signal: AbortSignal) =>
      client.request("/api/v1/portal/order-items", "get", {
        query: { tab: "all", limit: 20, cursor },
        signal,
      }),
    ads: (cursor: string | undefined, signal: AbortSignal) =>
      client.request("/api/v1/portal/ads", "get", {
        query: { status: ["pending_confirm"], limit: 20, cursor },
        signal,
      }),
  };
}
export type ItemsApi = ReturnType<typeof createItemsApi>;
