import type { components } from "@liyoxi/contract/types/merchant";
import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";
import { catalogCard, catalogCartItem, CATALOG_ID, CATALOG_NOW } from "./catalog-fixtures";
export const ORDER_ID = "00000000-0000-4000-8000-000000000401";
export const CHANNEL_ID = "00000000-0000-4000-8000-000000000501";
export const AGREEMENT_ID = "00000000-0000-4000-8000-000000000601";
export const orderAccount: components["schemas"]["ChannelAccountCard"] = {
  channelAccountId: CHANNEL_ID,
  platform: "douyin",
  accountName: "邻里咖啡",
  accountUid: "coffee-life",
  status: "available",
  accountType: "none",
  submittedAccountType: "none",
  certSubjectName: null,
  abnormalSource: null,
  abnormalReason: null,
  abnormalNote: null,
  roundNo: 1,
  submittedAt: CATALOG_NOW,
  reviewDueAt: null,
  verifiedAt: CATALOG_NOW,
  usage: { inProgressCount: 1, toLaunchCount: 0, liveCount: 0 },
  openTakedownTaskCount: 0,
  actions: [],
};
export const orderQuote: Data<"m.order.quote"> = {
  quotedAt: CATALOG_NOW,
  store: {
    storeId: "00000000-0000-4000-8000-000000000002",
    storeName: "邻里咖啡·街角店",
    entityName: "邻里生活服务有限公司",
    isEntityVerified: true,
    contactName: "林晓",
    contactPhoneMask: "138****8000",
  },
  plan: {
    planCode: "pro",
    planName: "专业版",
    productionModel: "advanced",
    discountBp: 7500,
    topModelSurchargeBp: 2000,
    isTopModelIncluded: false,
  },
  items: [
    {
      drama: catalogCard(),
      listPricePoints: 1200,
      discountBp: 7500,
      surchargeBp: 0,
      chargePoints: 900,
      discountDeltaPoints: -300,
      surchargeDeltaPoints: 0,
      allowedPlacements: ["opening", "ending"],
      platforms: ["douyin", "wechat_channels"],
      orderable: true,
      unorderableReason: null,
    },
  ],
  totalChargePoints: 900,
  spendablePoints: 18600,
  pointsShortfall: 0,
  allocation: { planLots: [{ expiresAt: "2027-01-06T16:00:00Z", points: 900 }], addonPoints: 0 },
  balanceAfter: { planPoints: 17700, addonPoints: 0 },
  channelAccounts: [
    {
      channelAccountId: CHANNEL_ID,
      platform: "douyin",
      accountName: "邻里咖啡",
      accountUid: "coffee-life",
      accountType: "none",
      status: "available",
      abnormalReason: null,
      isSelectable: true,
    },
  ],
  ads: [],
  earliestLaunchDate: "2026-10-21",
  agreement: {
    agreementKey: "custom_license",
    name: "定制内容授权使用协议",
    agreementVersionId: AGREEMENT_ID,
    versionLabel: "v1.0",
  },
  blockers: [],
  expect: { totalChargePoints: 900, items: [{ dramaId: CATALOG_ID, chargePoints: 900 }] },
};
export const orderItem: components["schemas"]["OrderItemInOrder"] = {
  orderItemId: "00000000-0000-4000-8000-000000000411",
  itemNo: 1,
  dramaId: CATALOG_ID,
  dramaTitle: catalogCard().title,
  posterUrl: null,
  genres: catalogCard().genres,
  episodeCount: 60,
  phase: "producing",
  phaseChangedAt: CATALOG_NOW,
  ticketStep: "sample_making",
  listPricePoints: 1200,
  discountBp: 7500,
  surchargeBp: 0,
  chargePoints: 900,
  productionModel: "advanced",
  accounts: [{ channelAccountId: CHANNEL_ID, platform: "douyin", accountName: "邻里咖啡" }],
  placements: [],
  agreedLaunchDate: "2026-10-21",
  usageStartDate: null,
  usageEndDate: "2027-03-31",
  usageEndSource: "license",
  liveEpisodeCount: 0,
  returnPoints: {
    refundRequestedPoints: 0,
    returnedPoints: 0,
    convertedPoints: 0,
    forfeitedPoints: 0,
  },
  cancelReasonCode: null,
  cancelledAt: null,
  timeline: [
    { key: "submitted", state: "done", at: CATALOG_NOW },
    { key: "started", state: "done", at: CATALOG_NOW },
    { key: "manager_assigned", state: "done", at: CATALOG_NOW },
    { key: "plan_confirmed", state: "done", at: CATALOG_NOW },
    { key: "sample_confirmed", state: "current", at: null },
    { key: "delivered", state: "todo", at: null },
    { key: "live", state: "todo", at: null },
    { key: "usage_ended", state: "todo", at: null },
  ],
};
export const orderDetail: Data<"m.order.get"> = {
  orderId: ORDER_ID,
  orderNo: "LYX2026100700018",
  submittedAt: CATALOG_NOW,
  status: "producing",
  subStatus: "sample_making",
  tab: "producing",
  itemCount: 1,
  totalChargePoints: 900,
  statusChangedAt: CATALOG_NOW,
  startedAt: CATALOG_NOW,
  closedAt: null,
  entityName: orderQuote.store.entityName,
  storeId: orderQuote.store.storeId,
  storeName: orderQuote.store.storeName,
  planCode: "pro",
  planName: "专业版",
  discountBp: 7500,
  isTopModel: false,
  surchargeBp: 0,
  focus: [{ code: "product", name: "主推服务" }],
  note: "展示街角店的日常氛围",
  expectedLaunchDate: null,
  referenceStoreAssetIds: [],
  pendingTodo: null,
  items: [orderItem],
  deliveryPlan: {
    deliveryPlanId: "00000000-0000-4000-8000-000000000421",
    status: "confirmed",
    confirmedVersionNo: 1,
    confirmedAt: CATALOG_NOW,
    summaryVersionNo: 1,
    focus: [{ code: "product", name: "主推服务" }],
    launchMode: "merchant_self",
    placements: [],
    agreedLaunchDate: "2026-10-21",
  },
  pointsEvents: [
    { opType: "hold", occurredAt: CATALOG_NOW, points: 900, planPoints: 900, addonPoints: 0 },
    { opType: "capture", occurredAt: CATALOG_NOW, points: 900, planPoints: 900, addonPoints: 0 },
  ],
  afterSales: [],
  agreements: [
    {
      agreementKey: "custom_license",
      name: orderQuote.agreement.name,
      agreementVersionId: AGREEMENT_ID,
      versionLabel: "v1.0",
      consentedAt: CATALOG_NOW,
    },
  ],
  licenseLetters: [],
  actions: [],
};
export const orderCard: components["schemas"]["OrderCard"] = {
  orderId: ORDER_ID,
  orderNo: orderDetail.orderNo,
  submittedAt: CATALOG_NOW,
  status: "producing",
  subStatus: "sample_making",
  tab: "producing",
  itemCount: 1,
  totalChargePoints: 900,
  actions: [],
  firstDramaTitle: catalogCard().title,
  platforms: ["douyin"],
  pinnedTodo: null,
  liveSummary: null,
  returnedPoints: 0,
};
export function offlineOrderRequest(scene: string): RequestLayer["request"] {
  const calls: { path: string; method: string; key?: string; data?: unknown }[] = [];
  (globalThis as { __LYX_ORDER_CALLS__?: typeof calls }).__LYX_ORDER_CALLS__ = calls;
  let creates = 0;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const url = new URL(path, "http://local"),
      method = options?.method ?? "GET";
    calls.push({
      path,
      method,
      ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
      ...(options?.data ? { data: options.data } : {}),
    });
    let data: unknown;
    if (url.pathname === "/m/orders/quote") {
      const changed = scene === "checkout-quote-changed" && creates > 0;
      data = {
        ...orderQuote,
        ...(changed
          ? {
              totalChargePoints: 990,
              items: [{ ...orderQuote.items[0]!, chargePoints: 990 }],
              expect: {
                totalChargePoints: 990,
                items: [{ dramaId: CATALOG_ID, chargePoints: 990 }],
              },
            }
          : {}),
        ...(scene === "checkout-points"
          ? {
              spendablePoints: 300,
              pointsShortfall: 600,
              blockers: [{ code: "POINTS_INSUFFICIENT", message: "可用积分不足，还差600积分" }],
            }
          : scene === "checkout-qualification"
            ? {
                blockers: [
                  { code: "STORE_NOT_QUALIFIED", message: "门店资质未通过，请完善门店资料" },
                ],
              }
            : {}),
      } satisfies Data<"m.order.quote">;
    } else if (url.pathname === "/m/channel-accounts")
      data = {
        items: [orderAccount],
        hasMore: false,
        nextCursor: null,
      } satisfies Data<"m.channelAccount.list">;
    else if (url.pathname === "/m/dict-items")
      data = {
        items: [
          {
            typeKey: "custom_focus",
            name: "定制重点",
            structure: "flat",
            versionNo: 1,
            items: ["product", "environment", "service"].map((code, i) => ({
              code,
              name: ["主推服务", "门店环境", "服务体验"][i]!,
              parentCode: null,
              description: null,
              tags: [],
              ext: {},
              position: i,
              isSelectable: true,
            })),
          },
        ],
      } satisfies Data<"m.dictItem.list">;
    else if (url.pathname === "/m/purchase-policy")
      data = {
        mode: "in_app",
        isPriceShown: true,
        isPurchasePromptAllowed: true,
        channels: [],
        copy: {
          planNounKey: "plan",
          pointsNounKey: "points",
          agreementKeys: [],
          payButtonKey: "pay",
        },
      } satisfies Data<"m.purchasePolicy.get">;
    else if (url.pathname === "/m/orders" && method === "GET")
      data = {
        items:
          scene === "orders-empty" ||
          (url.searchParams.get("tab") !== "all" && url.searchParams.get("tab") !== "producing")
            ? []
            : url.searchParams.get("cursor")
              ? [
                  {
                    ...orderCard,
                    orderId: "00000000-0000-4000-8000-000000000402",
                    orderNo: "LYX2026100700019",
                    firstDramaTitle: "邻里有好戏",
                  },
                ]
              : [orderCard],
        hasMore:
          scene !== "orders-empty" &&
          url.searchParams.get("tab") === "all" &&
          !url.searchParams.get("cursor"),
        nextCursor:
          scene !== "orders-empty" &&
          url.searchParams.get("tab") === "all" &&
          !url.searchParams.get("cursor")
            ? "order-page2"
            : null,
      } satisfies Data<"m.order.list">;
    else if (url.pathname === "/m/orders" && method === "POST") {
      if (!options?.idempotencyKey) throw new Error("订购必须携带意图key");
      creates++;
      if (creates === 1 && ["checkout-default", "checkout-quote-changed"].includes(scene))
        throw new ApiError({
          error: scene === "checkout-quote-changed" ? "QUOTE_CHANGED" : "NETWORK_ERROR",
          message: "网络暂时中断，请重试",
          status: scene === "checkout-quote-changed" ? 409 : 0,
          requestId: "order-offline",
        });
      data = { ...orderDetail, replayed: true } satisfies Data<"m.order.create">;
    } else if (url.pathname.startsWith("/m/orders/")) data = orderDetail;
    else if (url.pathname.startsWith("/m/order-items/"))
      data = {
        orderItemId: orderItem.orderItemId,
        dramaId: CATALOG_ID,
        dramaTitle: orderItem.dramaTitle,
        posterUrl: null,
        genres: orderItem.genres,
        episodeCount: 60,
        phase: "producing",
        ticketStep: "sample_making",
        accounts: [
          { ...orderItem.accounts[0]!, accountUid: orderAccount.accountUid, accountType: "none" },
        ],
        agreedLaunchDate: orderItem.agreedLaunchDate,
        usageStartDate: null,
        usageEndDate: orderItem.usageEndDate,
        liveEpisodeCount: 0,
        orderId: ORDER_ID,
        orderNo: orderDetail.orderNo,
        remainingDays: null,
        phaseChangedAt: CATALOG_NOW,
        usageEndSource: "license",
      } satisfies Data<"m.orderItem.get">;
    else if (url.pathname === "/m/cart-items")
      data = {
        items: [catalogCartItem(2)],
        limit: 50,
        plan: { planName: "专业版", discountBp: 7500 },
        spendablePoints: 17700,
      } satisfies Data<"m.cartItem.list">;
    else
      throw new ApiError({
        error: "NOT_FOUND",
        status: 404,
        message: `未登记的order离线接口 ${path}`,
        requestId: "order-offline",
        retryable: false,
      });
    return structuredClone(data) as T;
  };
}
