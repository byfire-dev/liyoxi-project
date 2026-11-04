import type { components } from "@liyoxi/contract/types/portal";
import type { PortalClient } from "../../lib/api";

export type Release = components["schemas"]["PortalReleaseView"];
export type DownloadBody = components["schemas"]["PortalDownloadBody"];
export type DownloadResult = components["schemas"]["PortalDownloadResult"];
export type PublishList = components["schemas"]["PublishListView"];

export function createItemApi(client: PortalClient) {
  return {
    release: (orderItemId: string, signal: AbortSignal) =>
      client.request("/api/v1/portal/order-items/{orderItemId}/release", "get", {
        path: { orderItemId },
        signal,
      }),
    download: (orderItemId: string, body: DownloadBody, signal: AbortSignal) =>
      client.request("/api/v1/portal/order-items/{orderItemId}/download-urls", "post", {
        path: { orderItemId },
        body,
        signal,
      }),
    publishList: (orderItemId: string, signal: AbortSignal) =>
      client.request("/api/v1/portal/order-items/{orderItemId}/publish-list", "get", {
        path: { orderItemId },
        signal,
      }),
  };
}
export type ItemApi = ReturnType<typeof createItemApi>;
