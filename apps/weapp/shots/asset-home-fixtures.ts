import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";
import type { DemandPage } from "../src/sub/asset/private/upload-api";
import { assetId, assetSummary } from "./asset-fixtures";

export const homeAssetDemands: DemandPage = {
  items: [
    {
      assetDemandId: assetId(9),
      title: "本周门店日常",
      shootingNote: "记录真实门店与服务",
      dueDate: "2026-10-20",
      status: "open",
      isOverdue: false,
      createdByName: "交付经理",
      receivedCount: 6,
      myUploadCount: 2,
      createdAt: "2026-10-12T02:00:00Z",
    },
  ],
  hasMore: false,
  nextCursor: null,
};
const fixtures = new Map<string, RequestLayer["request"]>();
/** 仅由显式 H5 样张标记进入；不读取 URL 决定离线数据。 */
export function offlineHomeAssetsRequest(scene: string): RequestLayer["request"] {
  const existing = fixtures.get(scene);
  if (existing) return existing;
  const calls: string[] = [];
  (globalThis as { __LYX_ASSET_HOME_CALLS__?: string[] }).__LYX_ASSET_HOME_CALLS__ = calls;
  let failed = false;
  const send: RequestLayer["request"] = async <T>(path: string): Promise<T> => {
    calls.push(path);
    const url = new URL(path, "http://local");
    if (
      scene === "asset-home-empty-error" &&
      url.pathname === "/m/store-assets/summary" &&
      !failed
    ) {
      failed = true;
      throw new ApiError({
        error: "FORBIDDEN",
        status: 403,
        requestId: "offline",
        message: "private",
      });
    }
    const empty = scene === "asset-home-empty-error";
    if (url.pathname === "/m/asset-demands")
      return (empty ? { items: [], nextCursor: null, hasMore: false } : homeAssetDemands) as T;
    if (url.pathname === "/m/store-assets/summary" && url.searchParams.get("uploader") === "me")
      return (
        empty
          ? {
              ...assetSummary,
              tabs: { all: 0, image: 0, video: 0, recording: 0, audio: 0, document: 0, text: 0 },
              organizingCount: 0,
              adoptedCount: 0,
              recent7dCount: 0,
              hotTags: [],
            }
          : assetSummary
      ) as T;
    throw new Error(`首页素材样张未登记 ${path}`);
  };
  fixtures.set(scene, send);
  return send;
}
