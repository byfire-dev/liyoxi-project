import type { Body, Data } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import type { Ad, AdPage, AdQuote } from "./api";

export const tabs = [
  { key: "all", label: "全部" },
  { key: "producing", label: "制作中" },
  { key: "pending_confirm", label: "待确认" },
  { key: "revising", label: "修改中" },
  { key: "confirmed", label: "已确认" },
] as const;
export const channelNames: Record<string, string> = {
  weapp: "小程序",
  album: "相册保存",
  portal: "电脑端预览",
  wecom: "企业微信",
};
export const adIdentity = (ad: Ad) => `${ad.adId}:${ad.currentVersionNo ?? ""}:${ad.status}`;
export function mergeAds(previous: AdPage | null, page: AdPage): AdPage {
  const items = [...(previous?.items ?? [])],
    seen = new Set(items.map((ad) => ad.adId));
  for (const item of page.items)
    if (!seen.has(item.adId)) {
      seen.add(item.adId);
      items.push(item);
    }
  return { ...page, items };
}
export function quoteIdentity(quote: AdQuote) {
  const { quotedAt: _at, ...facts } = quote;
  return JSON.stringify(facts);
}
export function createAdIntent(key: () => string) {
  let last = "",
    value = "";
  return (body: unknown) => {
    const next = JSON.stringify(body);
    if (next !== last || !value) {
      last = next;
      value = key();
    }
    return value;
  };
}
/** An attempted creation recovers its result before pricing another intent. */
export function createAdSubmission() {
  type Attempt = {
    body: Body<"m.ad.create">;
    key: string;
    current: () => boolean;
    adId?: string;
  };
  let pending: Attempt | null = null;
  return {
    pending: () => Boolean(pending?.current()),
    clear: () => {
      pending = null;
    },
    start: (body: Body<"m.ad.create">, key: string, current: () => boolean) => {
      pending = { body: JSON.parse(JSON.stringify(body)) as Body<"m.ad.create">, key, current };
    },
    async recover(
      api: {
        create(body: Body<"m.ad.create">, key: string): Promise<Pick<Data<"m.ad.create">, "adId">>;
        get(id: string): Promise<Ad>;
      },
      current: () => boolean,
    ): Promise<Ad | null> {
      const attempt = pending;
      const active = () => pending === attempt && Boolean(attempt?.current()) && current();
      if (!attempt || !active()) return null;
      if (!attempt.adId) {
        try {
          const result = await api.create(attempt.body, attempt.key);
          if (!active()) return null;
          attempt.adId = result.adId;
        } catch (error) {
          // A definite domain rejection has no result to restore; re-quote a new attempt.
          if (
            active() &&
            error instanceof ApiError &&
            error.error !== "NETWORK_ERROR" &&
            error.error !== "IDEMPOTENCY_IN_PROGRESS" &&
            error.error !== "INTERNAL" &&
            !error.error.startsWith("HTTP_")
          )
            pending = null;
          throw error;
        }
      }
      const actual = await api.get(attempt.adId);
      return active() ? actual : null;
    },
  };
}
export function confirmBody(ad: Ad, checked: boolean): Body<"m.ad.confirm"> {
  if (!checked) throw new Error("请先勾选已查看当前版本广告");
  const via = (["weapp", "album", "portal", "wecom"] as const).find(
    (value) => value === ad.confirmableVia[0],
  );
  if (!ad.actions.includes("confirm") || !ad.currentVersion || !via || ad.hasOpenCancelRequest)
    throw new Error("当前版本尚不满足确认条件，请刷新查看证据");
  return { versionNo: ad.currentVersion.versionNo, viewedVia: via, hasViewed: true };
}
export function changeBody(
  ad: Ad,
  note: string,
  segment: number | null,
  files: readonly string[],
  accepted: number | null,
  interval?: { start: number; end: number },
): Body<"m.ad.requestChange"> {
  if (!ad.actions.includes("request-change") || !ad.currentVersion || ad.hasOpenCancelRequest)
    throw new Error("当前广告不可提出修改，请刷新");
  if (!note.trim() || [...note.trim()].length > 200) throw new Error("请填写1至200字修改说明");
  if (
    files.length > ad.revisionScreenshotMax ||
    new Set(files).size !== files.length ||
    files.some((id) => !id)
  )
    throw new Error("截图数量超过当前上限或尚未上传完成");
  if (segment !== null && !ad.currentVersion.segments.some((s) => s.index === segment))
    throw new Error("所选分段已失效，请刷新");
  if (
    interval &&
    (segment !== null ||
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < 0 ||
      interval.end <= interval.start ||
      interval.end > ad.currentVersion.durationMs)
  )
    throw new Error("时间段须完整、递增且不超过本版时长");
  if (
    ad.freeRevisionsRemaining === 0 &&
    (ad.revisionUnitChargePoints === null || accepted !== ad.revisionUnitChargePoints)
  )
    throw new Error("请确认本次修改的实际积分");
  return {
    versionNo: ad.currentVersion.versionNo,
    note: note.trim(),
    ...(segment === null ? {} : { segmentIndex: segment }),
    ...(interval ? { timeStartMs: interval.start, timeEndMs: interval.end } : {}),
    ...(files.length ? { screenshotFileIds: [...files] } : {}),
    ...(ad.freeRevisionsRemaining === 0 ? { acceptChargePoints: accepted } : {}),
  };
}
export function assertSameVersion(before: Ad, fresh: Ad) {
  if (adIdentity(before) !== adIdentity(fresh)) throw new Error("广告版本或状态已更新，请重新核对");
}
export function adPlaybackSource(ad: Ad, playable: Data<"m.playable.get">, now: number): string {
  if (
    !ad.currentVersion?.previewChannels.includes("weapp") ||
    !ad.playable ||
    playable.kind !== "ad" ||
    playable.playableId !== ad.playable.playableId ||
    !playable.sources[0] ||
    !playable.expiresAt ||
    !Number.isFinite(Date.parse(playable.expiresAt)) ||
    Date.parse(playable.expiresAt) <= now + 5000
  )
    throw new Error("播放地址已失效，请重新获取当前版广告");
  return playable.sources[0].url;
}
export function adError(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      AD_VERSION_STALE: "广告已更新，请刷新后核对新版本",
      CHARGE_CHANGED: "修改积分已变化，请刷新并重新确认",
      POINTS_INSUFFICIENT: "可用积分不足，请核对后重试",
      AD_NOT_VIEWED: "当前版本缺少查看证据，请先按允许方式查看",
      FILE_NOT_USABLE: "截图不可用，请移除后重新上传",
      AGREEMENT_VERSION_STALE: "协议已更新，请重新报价并阅读",
      QUOTE_CHANGED: "报价已更新，请重新核对积分与协议",
    };
    return messages[error.error] ?? error.message;
  }
  return error instanceof Error ? error.message : "暂时无法操作，请重试";
}
