import type { operations } from "@liyoxi/contract/types/merchant";
import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type AssetPage = Data<"m.storeAsset.list">;
export type AssetCard = AssetPage["items"][number];
export type AssetSummary = Data<"m.storeAsset.summary">;
export type AssetDetail = Data<"m.storeAsset.get">;
export type AssetFile = AssetDetail["files"][number];
export type AssetQuery = NonNullable<operations["m.storeAsset.list"]["parameters"]["query"]>;
export type AssetFilters = Pick<AssetQuery, "status" | "tag" | "q" | "uploader">;
export type AssetTab = NonNullable<AssetQuery["tab"]>;
export const assetLabels = {
  all: "全部",
  image: "图片",
  video: "视频",
  recording: "录音",
  audio: "音频",
  document: "文档",
  text: "文字",
};
export const assetStatuses = {
  organizing: "整理中",
  adopted: "已采用",
  ready: "可直接使用",
  need_portrait_auth: "需肖像授权",
  need_reshoot: "需补拍",
  reference_only: "仅供参考",
};
/** 06-media.md:118 的内容安全结论；未知开放枚举不推断结果。 */
export function assetModerationLabel(state: AssetDetail["moderationState"]): string {
  switch (state) {
    case "none":
      return "不审或未开始";
    case "pending":
      return "审核中";
    case "pass":
      return "审核通过";
    case "review":
      return "可疑待人工";
    case "block":
      return "已拦截，请替换文件";
    default:
      return "审核状态待确认";
  }
}
export function assetTitle(item: AssetCard): string {
  return (
    item.title ??
    `${assetLabels[item.type]} · ${item.type === "text" ? "文字记录" : item.durationMs ? `${Math.ceil(item.durationMs / 1000)}秒` : `${item.fileCount}份`}`
  );
}

function query(value: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(value).filter(([, item]) => item !== undefined && item !== "");
  return pairs.length
    ? `?${pairs.map(([key, item]) => `${key}=${encodeURIComponent(String(item))}`).join("&")}`
    : "";
}
/** 三个既有只读入口；签名 URL 不进入路由或持久化。 */
export function createAssetApi(send: RequestLayer["request"]) {
  return {
    list: (filters: AssetFilters, tab: AssetTab, cursor?: string) =>
      send<AssetPage>(
        `/m/store-assets${query({ ...filters, tab, limit: 20, sort: "-createdAt", cursor })}`,
      ),
    summary: (filters: AssetFilters) =>
      send<AssetSummary>(`/m/store-assets/summary${query({ ...filters })}`),
    detail: (id: string) => send<AssetDetail>(`/m/store-assets/${encodeURIComponent(id)}`),
  };
}
export type AssetApi = ReturnType<typeof createAssetApi>;
