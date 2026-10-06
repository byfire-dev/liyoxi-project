import type { components } from "@liyoxi/contract/types/merchant";
import type { Data } from "../src/lib/account-api";
import { ApiError } from "../src/lib/request";
import type { RequestLayer } from "../src/lib/request";
export const CATALOG_NOW = "2026-10-07T00:00:00Z";
export const CATALOG_ID = "00000000-0000-4000-8000-000000000001";
export const catalogCard = (n = 1): components["schemas"]["DramaCard"] => ({
  dramaId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  title: ["烟火里的重逢", "邻里有好戏", "遇见新生活", "我们的街角"][n - 1] ?? `街角故事${n}`,
  posterUrl: null,
  genres: [{ code: "life", name: "都市生活" }],
  totalEpisodes: 60,
  heatTier: "A",
  badge: n === 1 ? "new" : null,
  listPricePoints: 1200,
  discountedPoints: 900,
  usableUntilDate: "2027-03-31",
});
export const catalogConfig: Data<"m.mallConfig.get"> = {
  revNo: 1,
  categories: [
    { key: "life", name: "都市生活", genres: [{ code: "life", name: "生活" }] },
    { key: "empty", name: "暂无分类", genres: [] },
  ],
  hotWords: [],
  filters: {
    genre: true,
    industry: true,
    episodes: true,
    price: true,
    episodeBands: [{ key: "short", label: "60集以下", min: null, max: 60 }],
    priceBands: [{ key: "low", label: "2000积分以下", min: null, max: 2000 }],
  },
  sorts: ["composite", "heat", "price_asc", "newest"],
  defaultSort: "composite",
  genres: [{ code: "life", name: "生活" }],
  industries: [{ code: "dining", name: "餐饮" }],
};
const bannerImage = {
  url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="686" height="288"><rect width="686" height="288" fill="#F2E6D6"/><circle cx="570" cy="90" r="130" fill="#E9D3B6"/><path d="M400 288 L490 60 L600 288" fill="#DFC39F"/></svg>')}`,
  expiresAt: "2027-01-01T00:00:00Z",
};
export const catalogHome: Data<"m.home.get"> = {
  viewerRole: "owner",
  city: { code: "310100", name: "上海" },
  banners: [
    {
      homeBannerId: CATALOG_ID,
      title: "让好故事走进本地生活",
      imageUrl: bannerImage,
      jumpKind: "mall",
      jumpTarget: { categoryKey: "life" },
    },
  ],
  hot: [catalogCard(1), catalogCard(2)],
  new: [catalogCard(1), catalogCard(3)],
  defaultTab: "hot",
  noticeBar: null,
  launchOverview: {
    liveItemCount: 3,
    liveEpisodeCount: 120,
    spendablePoints: 18600,
    planName: "专业版",
    termEndDate: "2027-01-06",
    expiringPlanPoints: 0,
    planPointsExpireAt: null,
  },
  recommend: {
    matchBy: { industry: { code: "dining", name: "餐饮" }, category: null },
    items: [catalogCard(1), catalogCard(2), catalogCard(3)],
  },
  cartCount: 2,
};
export const catalogDetail: Data<"m.drama.get"> = {
  ...catalogCard(),
  viewerRole: "owner",
  orderability: { orderable: true, reason: null },
  episodeDurationSec: 120,
  producerName: "本地生活制作组",
  castNames: "林晓、陈一",
  synopsis: "一家街角小店，连接了几位邻居的日常。重逢与互相照应，让平凡生活有了新的故事。",
  roles: [{ name: "林晓", actor: "林晓", desc: "经营街角小店的年轻人" }],
  industries: [{ code: "dining", name: "餐饮" }],
  targetAudience: "关注本地生活的用户",
  sellingTags: [{ code: "neighbor", name: "邻里故事", description: "日常生活场景" }],
  dramaClass: "class_1",
  allowedPlacements: ["opening", "ending"],
  placementDurations: [
    { slot: "opening", durationSecOptions: [5, 10] },
    { slot: "ending", durationSecOptions: [5, 10] },
  ],
  platforms: ["douyin", "wechat_channels"],
  permits: [{ platform: "all", kind: "license_no", number: "示例许可20260001" }],
  adUnitPoints: 200,
  topModelSurchargeBp: 2000,
  trailer: null,
  owner: {
    planName: "专业版",
    productionModel: "advanced",
    discountBp: 7500,
    adDiscountedPoints: 150,
    spendablePoints: 18600,
    expiringPlanPoints: 0,
    planPointsExpireAt: null,
    termEndDate: "2027-01-06",
    cartItemId: null,
  },
};
export const catalogCartItem = (n = 1): components["schemas"]["CartItem"] => ({
  cartItemId: `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
  drama: catalogCard(n),
  state: "valid",
  invalidReason: null,
  snapshotPricePoints: 1200,
  currentPricePoints: 1200,
  discountedPoints: 900,
  addedAt: CATALOG_NOW,
  priceAckedAt: null,
  actions: ["delete"],
});
export function offlineCatalogRequest(scene: string): RequestLayer["request"] {
  const role = scene.endsWith("clerk") ? "clerk" : scene.endsWith("guest") ? "guest" : "owner";
  let items: components["schemas"]["CartItem"][] = [catalogCartItem(1), catalogCartItem(2)];
  if (scene === "cart-invalid")
    items = [
      {
        ...catalogCartItem(1),
        state: "invalid",
        invalidReason: "not_listed",
        currentPricePoints: null,
        discountedPoints: null,
        drama: { ...catalogCard(1), listPricePoints: null, discountedPoints: null },
      },
      catalogCartItem(2),
    ];
  if (scene === "cart-price-changed")
    items = [
      {
        ...catalogCartItem(1),
        state: "price_changed",
        snapshotPricePoints: 1000,
        actions: ["accept-price", "delete"],
      },
      catalogCartItem(2),
    ];
  const mutations: { path: string; key: string | undefined; data: unknown }[] = [];
  (globalThis as { __LYX_CATALOG_MUTATIONS__?: typeof mutations }).__LYX_CATALOG_MUTATIONS__ =
    mutations;
  let acceptKey: string | undefined;
  const counts: Record<string, number> = {};
  (globalThis as { __LYX_CATALOG_COUNTS__?: Record<string, number> }).__LYX_CATALOG_COUNTS__ =
    counts;
  const withoutPrice = (n: number) => {
    const { discountedPoints: _, ...card } = catalogCard(n);
    return card;
  };
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const url = new URL(path, "http://local"),
      method = options?.method ?? "GET";
    counts[`${method} ${url.pathname}`] = (counts[`${method} ${url.pathname}`] ?? 0) + 1;
    let data: unknown;
    if (url.pathname === "/m/home")
      data =
        role === "clerk"
          ? ({
              viewerRole: "clerk",
              city: catalogHome.city,
              banners: catalogHome.banners,
            } satisfies Data<"m.home.get">)
          : role === "guest"
            ? ({
                viewerRole: "guest",
                city: catalogHome.city,
                banners: catalogHome.banners,
                hot: [withoutPrice(1), withoutPrice(2)],
                new: [withoutPrice(1)],
                defaultTab: "hot",
              } satisfies Data<"m.home.get">)
            : catalogHome;
    else if (url.pathname === "/m/mall-config") data = catalogConfig;
    else if (url.pathname === "/m/dramas")
      data = {
        viewerRole: "owner",
        viewerPlan: { planName: "专业版", discountBp: 7500 },
        items:
          scene === "mall-empty" || url.searchParams.get("category") === "empty"
            ? []
            : url.searchParams.get("cursor")
              ? [catalogCard(2), catalogCard(3)]
              : [catalogCard(1), catalogCard(2)],
        hasMore: scene !== "mall-empty" && !url.searchParams.get("cursor"),
        nextCursor: scene !== "mall-empty" && !url.searchParams.get("cursor") ? "page2" : null,
      } satisfies Data<"m.drama.list">;
    else if (url.pathname.startsWith("/m/dramas/")) data = catalogDetail;
    else if (url.pathname.startsWith("/m/cart-items")) {
      if (role !== "owner") throw new Error("店员/游客场景不得调用cart接口");
      if (method !== "GET")
        mutations.push({ path: url.pathname, key: options?.idempotencyKey, data: options?.data });
      if (method === "DELETE") {
        if (!options?.idempotencyKey) throw new Error("delete缺少意图key");
        items = items.filter((i) => i.cartItemId !== url.pathname.split("/")[3]);
        data = null;
      } else if (url.pathname.endsWith("/accept-price")) {
        const id = url.pathname.split("/")[3],
          body = options?.data;
        const current = items.find((i) => i.cartItemId === id);
        if (
          !options?.idempotencyKey ||
          !current ||
          typeof body !== "object" ||
          body === null ||
          !("acceptedPricePoints" in body) ||
          body.acceptedPricePoints !== current.currentPricePoints
        )
          throw new Error("accept必须发送真实当前P和key");
        if (scene === "cart-price-changed") {
          if (!acceptKey) {
            acceptKey = options.idempotencyKey;
            throw new ApiError({
              error: "NETWORK_ERROR",
              message: "网络暂时中断，请重试",
              status: 0,
              requestId: "catalog-offline",
              retryable: true,
            });
          }
          if (acceptKey !== options.idempotencyKey) throw new Error("同意图网络重试更换了key");
        }
        items = items.map((i) =>
          i.cartItemId === id
            ? {
                ...i,
                state: "valid",
                snapshotPricePoints: i.currentPricePoints!,
                priceAckedAt: CATALOG_NOW,
                actions: ["delete"],
              }
            : i,
        );
        data = {
          ...items.find((i) => i.cartItemId === id)!,
          replayed: scene === "cart-price-changed",
        } satisfies Data<"m.cartItem.acceptPrice">;
      } else if (method === "POST") {
        const item = catalogCartItem(1);
        if (!items.some((i) => i.cartItemId === item.cartItemId)) items.push(item);
        data = item;
      } else
        data = {
          items,
          limit: 50,
          plan: { planName: "专业版", discountBp: 7500 },
          spendablePoints: 18600,
        } satisfies Data<"m.cartItem.list">;
    } else throw new Error(`未登记的catalog离线接口 ${path}`);
    return structuredClone(data) as T;
  };
}
