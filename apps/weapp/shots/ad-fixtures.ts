// Explicit H5 offline transport; these DTOs do not prove live HTTP, media or WeChat delivery.
import type { Data } from "../src/lib/account-api";
import { ApiError, type RequestLayer } from "../src/lib/request";
import type { Ad, AdQuote } from "../src/sub/ad/private/types";
import { orderAd } from "./order-m5-fixtures";
import { dicts } from "./profile-fixtures";
import screenshot from "../src/sub/gallery/assets/sample-cover.png";
import { useBootstrapStore } from "../src/stores/bootstrap";
export const AD_ID = orderAd.adId;
export const adScreenshot = { fileId: "00000000-0000-4000-8000-000000000091", src: screenshot };
const now = "2026-10-07T02:00:00Z";
export const adDetail: Ad = {
  ...orderAd,
  status: "pending_confirm",
  displayStatus: "pending_confirm",
  confirmedVersionNo: null,
  confirmedAt: null,
  actions: ["confirm", "request-change"],
  isSelectable: false,
  remark: "突出街角小店的日常氛围",
  unitPricePoints: 100,
  discountBp: 10000,
  capturedAt: now,
  firstDueAt: now,
  editorName: "林剪辑",
  revisionUnitChargePoints: 45,
  revisionScreenshotMax: 1,
  currentVersion: {
    versionNo: 2,
    uploadedAt: now,
    pushedAt: now,
    durationMs: 5000,
    width: 1080,
    height: 1920,
    segments: [{ index: 0, fromMs: 0, toMs: 5000, label: "品牌露出" }],
    previewChannels: ["weapp"],
    offlineSentAt: null,
    decision: null,
    decidedAt: null,
    confirmViewedVia: null,
    viewedAckAt: null,
  },
  playable: {
    playableId: AD_ID,
    kind: "ad",
    durationMs: 5000,
    width: 1080,
    height: 1920,
    posterUrl: screenshot,
    sources: [
      { quality: "source", url: "/ad-preview.mp4", width: 1080, height: 1920, bitrateKbps: null },
    ],
    expiresAt: "2099-10-07T03:00:00Z",
    autoplay: false,
    muted: false,
  },
  alternatives: { canSaveToAlbum: false, canPreviewOnPortal: false, isOfflineSent: false },
  viewEvidence: { albumSavedAt: null, portalViewedAt: null },
  confirmableVia: ["weapp"],
  versions: [],
  revisions: [],
  references: [],
  floatingPlacements: [],
  relatedServiceTickets: [],
  timeline: [
    {
      at: now,
      action: "ad.push_version",
      title: "广告版本已推送",
      detail: "待您确认",
      versionNo: 2,
      actorType: "staff",
    },
  ],
};
adDetail.versions = [
  adDetail.currentVersion!,
  { ...adDetail.currentVersion!, versionNo: 1, decision: "superseded", decidedAt: now },
];
export const adQuote: AdQuote = {
  unitPoints: 100,
  discountBp: 10000,
  chargePoints: null,
  freeRevisions: 2,
  planName: "成长套餐",
  availablePoints: 360,
  availableAfterPoints: null,
  typeOptions: [
    { type: "opening", durationOptions: [3, 5] },
    { type: "ending", durationOptions: [5, 10] },
  ],
  storeGate: "full",
  blockers: [],
  agreement: {
    agreementKey: "ad_service",
    name: "广告制作服务协议",
    agreementVersionId: AD_ID,
    versionLabel: "v1.0",
    needsCheck: true,
  },
  quotedAt: now,
};
type Call = { path: string; method: string; key?: string; data?: unknown };
export function offlineAdRequest(scene: string): RequestLayer["request"] {
  const bootstrap = useBootstrapStore.getState();
  bootstrap.apply(
    { flags: { ...bootstrap.data.flags, "weapp.video.ad.enabled": scene !== "ad-no-evidence" } },
    Date.now(),
  );
  const ad = structuredClone(adDetail),
    calls: Call[] = [];
  const global = globalThis as {
    __LYX_AD_CALLS__?: Call[];
    __LYX_AD_CONTROL__?: {
      nextVersion(): void;
      failNext(): void;
      creation(): { createdCount: number; holdCount: number; availablePoints: number };
    };
  };
  global.__LYX_AD_CALLS__ = calls;
  let fail = scene === "ad-error",
    failWrite = false,
    lostCreateReply = scene === "ad-create",
    failCreatedRead = scene === "ad-create",
    availablePoints = scene === "ad-create" ? 100 : adQuote.availablePoints,
    createdCount = 0,
    holdCount = 0;
  const creations = new Map<string, { fingerprint: string; ad: Ad }>();
  if (scene === "ad-change-paid") {
    ad.freeRevisionsRemaining = 0;
    ad.revisionCount = 2;
  }
  if (scene === "ad-no-evidence") {
    ad.confirmableVia = [];
    ad.currentVersion!.previewChannels = ["album", "portal"];
    ad.alternatives = { canSaveToAlbum: true, canPreviewOnPortal: true, isOfflineSent: false };
    ad.playable = null;
  }
  if (scene === "ad-returned") {
    ad.status = "returned";
    ad.displayStatus = "producing";
    ad.waitingReason = "materials";
    ad.returnReason = "请补充门店实拍素材";
    ad.actions = ["submit"];
    ad.currentVersion = null;
    ad.currentVersionNo = null;
    ad.playable = null;
    ad.versions = [];
  }
  global.__LYX_AD_CONTROL__ = {
    nextVersion() {
      ad.currentVersionNo = 3;
      ad.currentVersion = { ...adDetail.currentVersion!, versionNo: 3 };
      ad.versions.unshift(ad.currentVersion);
    },
    failNext() {
      failWrite = true;
    },
    creation: () => ({ createdCount, holdCount, availablePoints }),
  };
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    calls.push({
      path,
      method: options?.method ?? "GET",
      key: options?.idempotencyKey,
      data: options?.data,
    });
    if (fail) {
      fail = false;
      throw new Error("广告加载失败，请重试");
    }
    if (options?.method === "POST" && path !== "/m/ads/quote" && failWrite) {
      failWrite = false;
      throw new Error("网络暂时中断，请重试");
    }
    let value: unknown;
    if (path.startsWith("/m/ads?")) {
      const query = new URL(`http://offline${path}`).searchParams;
      const isNext = query.has("cursor");
      value = {
        items:
          scene === "ad-empty" ||
          (query.get("tab") !== "all" && query.get("tab") !== ad.displayStatus)
            ? []
            : [
                isNext
                  ? {
                      ...ad,
                      adId: "00000000-0000-4000-8000-000000000802",
                      adNo: "GG202610070002",
                      copy: "门店新风味",
                    }
                  : ad,
              ],
        nextCursor: scene === "ad-list" && !isNext ? "ad-next+/?" : null,
        hasMore: scene === "ad-list" && !isNext,
      } satisfies Data<"m.ad.list">;
    } else if (path === "/m/ads/quote") {
      const body = options?.data as { durationSec?: number };
      value = {
        ...adQuote,
        availablePoints,
        agreement: { ...adQuote.agreement, needsCheck: createdCount === 0 },
        ...(body.durationSec
          ? { chargePoints: 100, availableAfterPoints: availablePoints - 100 }
          : {}),
        ...(createdCount
          ? { blockers: [{ code: "POINTS_INSUFFICIENT", message: "可用积分不足" }] }
          : {}),
      } satisfies AdQuote;
    } else if (path.startsWith("/m/dict-items"))
      value = {
        items: [
          {
            ...dicts.items[0]!,
            typeKey: "ad_promo_point",
            name: "广告推广重点",
            structure: "flat",
            items: [{ ...dicts.items[0]!.items[0]!, code: "product", name: "主推服务" }],
          },
        ],
      } satisfies Data<"m.dictItem.list">;
    else if (path.startsWith("/m/store-assets?"))
      value = { items: [], nextCursor: null, hasMore: false } satisfies Data<"m.storeAsset.list">;
    else if (path.startsWith("/m/playables/")) value = ad.playable;
    else if (path.endsWith("/download-urls"))
      value = {
        url: "/ad-preview.mp4",
        expiresAt: "2099-10-07T03:00:00Z",
        fileName: "advertisement.mp4",
        sizeBytes: "2048",
      } satisfies Data<"m.ad.downloadUrls">;
    else if (path.endsWith("/confirm")) {
      const body = options?.data as { versionNo: number };
      if (body.versionNo !== ad.currentVersionNo)
        throw new ApiError({
          error: "AD_VERSION_STALE",
          message: "广告已更新",
          status: 409,
          requestId: "offline-ad",
        });
      if (!ad.confirmableVia.length)
        throw new ApiError({
          error: "AD_NOT_VIEWED",
          message: "缺少查看证据",
          status: 409,
          requestId: "offline-ad",
        });
      ad.status = "confirmed";
      ad.displayStatus = "confirmed";
      ad.confirmedVersionNo = ad.currentVersionNo;
      ad.confirmedAt = now;
      ad.isSelectable = true;
      ad.currentVersion!.decision = "confirmed";
      ad.currentVersion!.decidedAt = now;
      ad.actions = ["request-change"];
      value = ad;
    } else if (path.endsWith("/request-change")) {
      ad.status = "revising";
      ad.displayStatus = "revising";
      ad.actions = [];
      value = {
        ad,
        revision: {
          revisionNo: 3,
          onVersionNo: 2,
          source: "ad_page",
          isChargeable: true,
          chargePoints: 45,
          segmentIndex: null,
          timeStartMs: null,
          timeEndMs: null,
          note: "广告字幕请上移",
          screenshotFileIds: [],
          actorType: "merchant",
          createdAt: now,
          dueAt: now,
          fulfilledByVersionNo: null,
        },
      } satisfies Data<"m.ad.requestChange">;
    } else if (path.endsWith("/submit")) {
      ad.status = "producing";
      ad.waitingReason = null;
      ad.actions = [];
      value = ad;
    } else if (path === "/m/ads" && options?.method === "POST") {
      const key = options.idempotencyKey!;
      const fingerprint = JSON.stringify(options.data);
      const replay = creations.get(key);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new Error("原创建意图正文被更改");
        return structuredClone(replay.ad) as T;
      }
      if (availablePoints < 100)
        throw new ApiError({
          error: "POINTS_INSUFFICIENT",
          message: "可用积分不足",
          status: 409,
          requestId: "offline-ad",
        });
      availablePoints -= 100;
      createdCount++;
      holdCount++;
      ad.status = "pending_assign";
      ad.displayStatus = "producing";
      ad.actions = [];
      ad.currentVersion = null;
      ad.currentVersionNo = null;
      ad.playable = null;
      ad.versions = [];
      ad.confirmableVia = [];
      creations.set(key, { fingerprint, ad: structuredClone(ad) });
      if (lostCreateReply) {
        lostCreateReply = false;
        throw new Error("网络暂时中断，请重试");
      }
      value = ad;
    } else if (path === `/m/ads/${AD_ID}`) {
      if (createdCount && failCreatedRead) {
        failCreatedRead = false;
        throw new Error("需求已受理，暂时无法取得广告，请重试");
      }
      value = ad;
    } else throw new Error(`广告离线场景未登记调用：${path}`);
    return structuredClone(value) as T;
  };
}
