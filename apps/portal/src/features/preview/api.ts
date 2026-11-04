import type { components } from "@liyoxi/contract/types/portal";
import type { PortalClient } from "../../lib/api";
import { PortalApiError } from "../../lib/api-errors";

export type AdDetail = components["schemas"]["PortalAdDetail"];
export type AdPlayback = components["schemas"]["Playable"];
export const validPreviewId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

export function createAdPreviewApi(client: PortalClient) {
  return {
    detail: (adId: string, signal?: AbortSignal): Promise<AdDetail> =>
      client.request("/api/v1/portal/ads/{adId}", "get", { path: { adId }, signal }),
    async playback(adId: string, versionNo: number, signal?: AbortSignal): Promise<AdPlayback> {
      const result = await client.request("/api/v1/portal/ads/{adId}/playback-urls", "post", {
        path: { adId },
        body: { versionNo },
        signal,
      });
      if (
        result.kind !== "ad" ||
        !result.sources.length ||
        !result.expiresAt ||
        !Number.isFinite(Date.parse(result.expiresAt))
      )
        throw new PortalApiError("INVALID_RESPONSE");
      for (const source of result.sources) {
        let url: URL;
        try {
          url = new URL(source.url);
        } catch {
          throw new PortalApiError("INVALID_RESPONSE");
        }
        if (url.protocol !== "https:" || url.username || url.password)
          throw new PortalApiError("INVALID_RESPONSE");
      }
      return result;
    },
  };
}
