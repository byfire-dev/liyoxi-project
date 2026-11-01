// Explicit offline H5 transport only; not live HTTP/backend or WeChat acceptance.
import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";
import { offlineOrderRequest, orderDetail, orderQuote, ORDER_ID } from "./order-fixtures";
export const orderAd: Data<"m.ad.list">["items"][number] = {
  adId: "00000000-0000-4000-8000-000000000801",
  adNo: "GG202610070001",
  type: "opening",
  durationSec: 5,
  status: "confirmed",
  displayStatus: "confirmed",
  waitingReason: null,
  currentVersionNo: 2,
  confirmedVersionNo: 2,
  confirmedAt: orderDetail.submittedAt,
  revisionCount: 0,
  freeRevisionsRemaining: 2,
  chargePoints: 100,
  isCaptured: true,
  dueAt: null,
  dueKind: null,
  hasOpenCancelRequest: false,
  actions: [],
  returnReason: null,
  copy: "街角一杯咖啡",
  promoPoints: [],
  coverUrl: null,
  coverExpiresAt: null,
  currentPreviewChannels: ["weapp"],
  isSelectable: true,
  freeRevisionQuota: 2,
  usage: { inUseCount: 0, firstDramaTitle: null },
  submittedAt: orderDetail.submittedAt,
  updatedAt: orderDetail.submittedAt,
};
export const dramaRow: Data<"m.orderItem.list">["items"][number] = {
  orderItemId: orderDetail.items[0]!.orderItemId,
  dramaId: orderDetail.items[0]!.dramaId,
  dramaTitle: orderDetail.items[0]!.dramaTitle,
  posterUrl: null,
  genres: orderDetail.items[0]!.genres,
  episodeCount: 60,
  phase: "live",
  ticketStep: "in_service",
  accounts: orderDetail.items[0]!.accounts,
  agreedLaunchDate: "2026-10-01",
  usageStartDate: "2026-10-01",
  usageEndDate: "2027-03-31",
  liveEpisodeCount: 60,
  orderId: ORDER_ID,
  orderNo: orderDetail.orderNo,
  remainingDays: 175,
  pendingTodo: null,
};
export const quoteWithAd: Data<"m.order.quote"> = {
  ...orderQuote,
  ads: [
    {
      adId: orderAd.adId,
      adNo: orderAd.adNo,
      type: "opening",
      durationSec: 5,
      copy: orderAd.copy,
      confirmedVersionNo: 2,
      confirmedAt: orderDetail.submittedAt,
    },
  ],
};
export function offlineM5OrderRequest(scene: string): RequestLayer["request"] {
  const base = offlineOrderRequest(scene),
    global = globalThis as {
      __LYX_ORDER_CALLS__?: { path: string; method: string; key?: string; data?: unknown }[];
    };
  let invalid = false,
    failed = false,
    created = false;
  (
    globalThis as { __LYX_ORDER_M5_CONTROL__?: { invalidateAds(): void } }
  ).__LYX_ORDER_M5_CONTROL__ = {
    invalidateAds() {
      invalid = true;
    },
  };
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const url = new URL(path, "https://offline.invalid"),
      method = options?.method ?? "GET";
    let value: unknown;
    if (url.pathname === "/m/ads")
      value = {
        items: [
          { ...orderAd, ...(invalid ? { isSelectable: false, hasOpenCancelRequest: true } : {}) },
        ],
        nextCursor: null,
        hasMore: false,
      } satisfies Data<"m.ad.list">;
    else if (url.pathname === "/m/orders/quote")
      value = { ...quoteWithAd, ads: invalid ? [] : quoteWithAd.ads };
    else if (url.pathname === "/m/order-items/summary")
      value =
        scene === "my-dramas-empty"
          ? { all: 0, live: 0, to_launch: 0, ended: 0, delivering: 0 }
          : ({
              all: 2,
              live: 1,
              to_launch: 1,
              ended: 0,
              delivering: 1,
            } satisfies Data<"m.orderItem.summary">);
    else if (url.pathname === "/m/order-items") {
      if (scene === "my-dramas-error" && !failed) {
        failed = true;
        throw new Error("短剧加载失败，请重试");
      }
      const tab = url.searchParams.get("tab"),
        more = Boolean(url.searchParams.get("cursor"));
      value = {
        items:
          scene === "my-dramas-empty" || tab === "ended"
            ? []
            : more
              ? [
                  dramaRow,
                  {
                    ...dramaRow,
                    orderItemId: "00000000-0000-4000-8000-000000000412",
                    dramaTitle: "邻里有好戏",
                    phase: "to_launch",
                    liveEpisodeCount: 0,
                    usageStartDate: null,
                    remainingDays: null,
                  },
                ]
              : [dramaRow],
        hasMore: scene !== "my-dramas-empty" && tab === "all" && !more,
        nextCursor: scene !== "my-dramas-empty" && tab === "all" && !more ? "m5-next+/?" : null,
      } satisfies Data<"m.orderItem.list">;
    } else if (url.pathname === `/m/orders/${ORDER_ID}` && scene === "order-detail-after-sale")
      value = {
        ...orderDetail,
        afterSales: [
          {
            cancelRequestId: orderAd.adId,
            requestNo: "QX202610070001",
            status: "pending_execution",
            closeReason: null,
            reasonCode: "merchant_request",
            submittedAt: orderDetail.submittedAt,
            executedAt: null,
            kind: "order_cancel",
            totalRefundPoints: 900,
            lines: [
              {
                orderItemId: dramaRow.orderItemId,
                mode: "refund",
                refundPoints: 900,
                returnedPoints: null,
                convertedPoints: null,
                forfeitedPoints: null,
              },
            ],
          },
        ],
        licenseLetters: [
          {
            licenseLetterId: orderAd.adId,
            letterNo: "SQ202610070001-DY",
            orderItemId: dramaRow.orderItemId,
            platform: "douyin",
            accountName: "邻里咖啡",
            status: "pending_effective",
            displayStatus: "pending_effective",
            periodStartDate: null,
            periodEndDate: "2027-03-31",
          },
        ],
      } satisfies Data<"m.order.get">;
    else if (
      url.pathname === "/m/orders" &&
      method === "POST" &&
      scene === "checkout-ads" &&
      !created
    ) {
      created = true;
      global.__LYX_ORDER_CALLS__!.push({
        path,
        method,
        key: options?.idempotencyKey,
        data: options?.data,
      });
      throw new ApiError({
        error: "NETWORK_ERROR",
        status: 0,
        requestId: "m5-offline",
        message: "网络暂时中断，请重试",
      });
    } else return base(path, options);
    global.__LYX_ORDER_CALLS__!.push({
      path,
      method,
      key: options?.idempotencyKey,
      data: options?.data,
    });
    return structuredClone(value) as T;
  };
}
