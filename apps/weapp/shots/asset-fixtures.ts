import type { AssetCard, AssetDetail, AssetPage, AssetSummary } from "../src/sub/asset/private/api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";

export const assetId = (n = 1) => `019aa000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-10-12T02:00:00.000Z",
  EXPIRES = "2099-10-12T02:00:00.000Z";
// 内嵌离线示意图，不是云签名内容或像素验真。
const IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="white"/><text x="24" y="65" font-size="22">门店素材</text></svg>')}`;
const tag: AssetCard["tags"][number] = {
  dimension: "content",
  tag: { code: "store", name: "门店环境" },
  source: "uploader",
  isConfirmed: true,
  validStartDate: null,
  validEndDate: null,
};
export function assetCard(n = 1, type: AssetCard["type"] = "image"): AssetCard {
  return {
    storeAssetId: assetId(n),
    type,
    title: n === 2 ? null : "午后的门店与服务",
    displayStatus: "ready",
    processingState: "processed",
    reviewState: "reviewed",
    usability: "ready",
    adoptedCount: 2,
    moderationState: "pass",
    fileCount: type === "text" ? 0 : 2,
    durationMs: type === "video" || type === "audio" || type === "recording" ? 12000 : null,
    pageCount: type === "document" ? 3 : null,
    thumbnail: type === "image" ? { url: IMAGE, expiresAt: EXPIRES } : null,
    quote: "展示门店环境与日常服务",
    tags: [tag],
    techSpecLabel: "原始素材",
    structuredItemCount: 1,
    isSelectableAsReference: true,
    uploader: { actorType: "merchant", role: "owner", displayName: "林店长", isMe: true },
    createdAt: NOW,
  };
}
export function assetDetail(type: AssetCard["type"] = "image"): AssetDetail {
  const card = assetCard(1, type);
  const kind = type === "recording" ? "audio" : type === "text" ? "document" : type;
  return {
    ...card,
    textBody: type === "text" ? "每日现磨咖啡，欢迎来店坐坐。" : null,
    note: type === "text" ? null : "门店实拍，保留原始声音。",
    files:
      type === "text"
        ? []
        : [1, 2].map((n) => ({
            fileId: assetId(100 + n),
            kind,
            url: kind === "image" ? IMAGE : null,
            expiresAt: kind === "image" ? EXPIRES : null,
            coverUrl: null,
            durationMs: card.durationMs,
            displayWidth: kind === "image" ? 160 : null,
            displayHeight: kind === "image" ? 120 : null,
            moderationState: "pass",
          })),
    transcript: {
      text: "欢迎光临，这是今天的门店记录。",
      segments: [{ fromMs: 0, toMs: 3000, text: "欢迎光临" }],
    },
    fileTranscripts: [],
    highlights: ["门店环境明亮", "保留日常服务声音"],
    structuredItems: [{ name: "手冲咖啡", priceText: "以门店当日标价为准" }],
    isInsightPartial: false,
    tagsByDimension: { content: [tag], usage: [], timeliness: [] },
    reviewedBy: { displayName: "交付经理" },
    reviewedAt: NOW,
    portraitAuth: { fileCount: 1, authorizedAt: NOW },
    assetDemand: { assetDemandId: assetId(9), title: "本周门店日常" },
    timeline: [
      { kind: "uploaded", at: NOW, actorName: "林店长", usedBy: null },
      {
        kind: "used_as_reference",
        at: NOW,
        actorName: null,
        usedBy: { type: "drama_order", id: assetId(8), no: "D202610120001" },
      },
    ],
    actions: ["feedback"],
  };
}
export function assetPage(ids = [1, 2, 3], hasMore = false): AssetPage {
  return {
    items: ids.map((n) => assetCard(n)),
    nextCursor: hasMore ? "opaque:cursor+中文/1" : null,
    hasMore,
  };
}
export const assetSummary: AssetSummary = {
  tabs: { all: 26, image: 9, video: 4, recording: 3, audio: 2, document: 4, text: 4 },
  organizingCount: 3,
  adoptedCount: 8,
  recent7dCount: 12,
  hotTags: [{ dimension: "content", tag: tag.tag, assetCount: 9 }],
};
export function offlineAssetRequest(scene: string): RequestLayer["request"] {
  const calls: { path: string; method: string }[] = [];
  const pending: (() => void)[] = [];
  let hold = false,
    moreFailed = false,
    detailReads = 0;
  const control = {
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      pending.splice(0).forEach((run) => run());
    },
  };
  (globalThis as { __LYX_ASSET_CALLS__?: typeof calls }).__LYX_ASSET_CALLS__ = calls;
  (globalThis as { __LYX_ASSET_CONTROL__?: typeof control }).__LYX_ASSET_CONTROL__ = control;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    calls.push({ path, method: options?.method ?? "GET" });
    const url = new URL(path, "https://offline.invalid");
    const frozen = scene === "asset-lib-loading";
    if (hold || frozen) await new Promise<void>((resolve) => pending.push(resolve));
    if (scene === "asset-lib-error" || scene === "asset-detail-error")
      throw new Error("private URL must not escape");
    if (url.pathname === "/m/store-assets/summary")
      return (
        scene === "asset-lib-empty"
          ? {
              ...assetSummary,
              tabs: { all: 0, image: 0, video: 0, recording: 0, audio: 0, document: 0, text: 0 },
            }
          : assetSummary
      ) as T;
    if (url.pathname === "/m/store-assets") {
      const more = url.searchParams.has("cursor");
      if (scene === "asset-lib-more-error" && more && !moreFailed) {
        moreFailed = true;
        throw new Error("more");
      }
      return assetPage(
        scene === "asset-lib-empty" || scene === "asset-lib-filter-empty"
          ? []
          : more
            ? [3, 4, 4, 5]
            : [1, 2, 3],
        scene === "asset-lib-more-error" && !more,
      ) as T;
    }
    if (scene === "asset-detail-missing")
      throw new ApiError({
        error: "NOT_FOUND",
        message: "private",
        status: 404,
        requestId: "offline",
      });
    if (url.pathname.startsWith("/m/store-assets/")) {
      detailReads++;
      const type = scene.replace("asset-detail-", "");
      const detail = assetDetail(
        type === "video" ||
          type === "audio" ||
          type === "recording" ||
          type === "document" ||
          type === "text"
          ? type
          : "image",
      );
      if (scene === "asset-detail-image" && detail.files[0])
        detail.files[0].moderationState = "review";
      if (scene === "asset-detail-partial") {
        detail.isInsightPartial = true;
        detail.actions = ["feedback", "portrait-auth"];
        detail.usability = "need_portrait_auth";
        detail.displayStatus = "need_portrait_auth";
      }
      if (scene === "asset-detail-organizing") {
        detail.processingState = "processing";
        detail.displayStatus = "organizing";
        detail.highlights = [];
      }
      if (detailReads > 1 && detail.files[0])
        detail.files[0] = { ...detail.files[0], expiresAt: EXPIRES };
      return detail as T;
    }
    throw new Error("未登记素材离线入口");
  };
}
