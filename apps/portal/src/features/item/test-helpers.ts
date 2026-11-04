import type { DownloadResult, PublishList, Release } from "./api";

export const ITEM_ID = "019a4500-0000-7000-8000-000000000101";
export const RELEASE: Release = {
  orderItemId: ITEM_ID,
  deliveryReleaseId: "019a4500-0000-7000-8000-000000000102",
  orderNo: "LYX202611040001",
  dramaTitle: "巷口那家店",
  releaseNo: 2,
  kind: "reissue",
  pushedAt: "2026-11-04T00:00:00.000Z",
  episodeCount: 2,
  totalBytes: "2048",
  changedEpisodeNos: [2],
  usageEndDate: "2027-01-01",
  state: "pushed",
  closeReason: null,
  reissueReason: { code: "corrected", name: "内容修订" },
  episodes: [1, 2].map((episodeNo) => ({
    episodeNo,
    fileName: `第${episodeNo}集.mp4`,
    sizeBytes: "1024",
    isChanged: episodeNo === 2,
    lastPortalDownloadAt: null,
  })),
  grant: { state: "active", expiresAt: "2026-12-04T00:00:00.000Z", isExpired: false },
  isDownloadable: true,
  downloadBlocker: null,
  zipFileName: "巷口那家店_全2集.zip",
  hasPublishList: true,
};
export const PUBLISH_LIST: PublishList = {
  orderItemId: ITEM_ID,
  releaseNo: 2,
  collectionName: "巷口那家店",
  cover: null,
  topics: ["门店故事"],
  intro: "清单简介",
  isAiDeclarationRequired: true,
  episodes: [{ episodeNo: 1, title: "开张", topics: [], intro: null, isUpdated: false }],
  text: "合集：巷口那家店\n第 1 集：开张\nAI 创作标识",
};
export function result(
  kind: DownloadResult["kind"] = "episode",
  state: DownloadResult["state"] = "ready",
): DownloadResult {
  return {
    kind,
    state,
    downloadId: state === "ready" ? "019a4500-0000-7000-8000-000000000103" : null,
    episodeNo: kind === "episode" ? 1 : null,
    url: state === "ready" ? "https://download.example.invalid/object?sign=transient" : null,
    expiresAt: state === "ready" ? "2026-12-04T00:00:00.000Z" : null,
    fileName: state === "ready" ? `${kind}.bin` : null,
    sizeBytes: state === "ready" ? "1024" : null,
    pollAfterSec: kind === "zip" && state === "building" ? 5 : null,
  };
}
