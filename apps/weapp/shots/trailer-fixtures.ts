import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import {
  catalogCard,
  catalogConfig,
  catalogDetail,
  offlineCatalogRequest,
} from "./catalog-fixtures";

export function trailerDetail(n = 1): Data<"m.drama.get"> {
  return {
    ...structuredClone(catalogDetail),
    ...catalogCard(n),
    trailer:
      n === 2
        ? null
        : {
            playableId: `00000000-0000-4000-8000-${String(700 + n).padStart(12, "0")}`,
            posterUrl: null,
            durationMs: 1000,
          },
  };
}

/** 显式 H5 场景专用；视频地址由截图脚本提供同源本地1秒媒体，不访问外网。 */
export function offlineTrailerRequest(scene: string): RequestLayer["request"] {
  const width = scene.includes("landscape") ? 320 : 180,
    height = scene.includes("landscape") ? 180 : 320;
  const calls: { path: string; method: string }[] = [];
  (globalThis as { __LYX_TRAILER_CALLS__?: typeof calls }).__LYX_TRAILER_CALLS__ = calls;
  const fallback = offlineCatalogRequest("detail-owner");
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    calls.push({ path, method: options?.method ?? "GET" });
    const url = new URL(path, "http://local");
    if (url.pathname === "/m/mall-config") return catalogConfig as T;
    if (url.pathname === "/m/dramas") {
      if (scene === "trailer-error") throw new Error("预告片列表加载失败，请重试");
      return {
        viewerRole: "owner",
        viewerPlan: { planName: "专业版", discountBp: 7500 },
        items: scene === "trailer-empty" ? [] : [catalogCard(1), catalogCard(2)],
        nextCursor: null,
        hasMore: false,
      } as T;
    }
    if (url.pathname.startsWith("/m/dramas/")) {
      const id = url.pathname.split("/").at(-1)!;
      return trailerDetail(Number(id.slice(-3))) as T;
    }
    if (url.pathname.startsWith("/m/playables/"))
      return {
        playableId: url.pathname.split("/").at(-1),
        kind: "trailer",
        durationMs: 1000,
        width,
        height,
        posterUrl: null,
        sources: [
          {
            quality: "sd",
            url:
              (globalThis as { __LYX_TRAILER_MEDIA_URL__?: string }).__LYX_TRAILER_MEDIA_URL__ ??
              "/__lyx_trailer_fixture.mp4",
            width,
            height,
            bitrateKbps: null,
          },
        ],
        expiresAt: "2099-01-01T00:00:00Z",
        autoplay: false,
        muted: true,
      } as T;
    return fallback<T>(path, options);
  };
}
