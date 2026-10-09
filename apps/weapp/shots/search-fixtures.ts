import type { RequestLayer } from "../src/lib/request";
import type { SearchCard, SearchConfig, SearchPage } from "../src/sub/catalog/search/api";
import { catalogCard, catalogConfig } from "./catalog-fixtures";

export const searchConfig: SearchConfig = {
  ...catalogConfig,
  hotWords: ["烟火", "都市生活", "林晓", "餐饮", "街角", "重逢", "温情", "邻里"],
};
export function searchPage(
  role: SearchPage["viewerRole"] = "owner",
  options: {
    ids?: number[];
    mode?: "match" | "industry_fallback";
    hasMore?: boolean;
    fields?: ("title" | "genre" | "cast")[];
  } = {},
): SearchPage {
  const common = {
    mode: options.mode ?? "match",
    fallbackIndustry:
      options.mode === "industry_fallback"
        ? { code: "dining", name: "餐饮", keywordCategoryName: "火锅" }
        : null,
    totalApprox: 24,
    hasMore: options.hasMore ?? false,
    nextCursor: options.hasMore ? "opaque:search+cursor/first" : null,
  };
  const items = (options.ids ?? [1, 2, 3]).map((id) => {
    const { discountedPoints: _discount, ...card } = catalogCard(id);
    return { ...card, matchedFields: options.fields ?? ["title", "genre", "cast"] };
  });
  if (role === "owner")
    return {
      ...common,
      viewerRole: "owner",
      viewerPlan: { planName: "专业版", discountBp: 7500 },
      items: items.map((item) => ({ ...item, discountedPoints: 900 })),
    };
  if (role === "clerk") return { ...common, viewerRole: "clerk", viewerPlan: null, items };
  return { ...common, viewerRole: "guest", viewerPlan: null, items };
}
export function offlineSearchRequest(scene: string): RequestLayer["request"] {
  const role = scene.endsWith("clerk") ? "clerk" : scene.endsWith("guest") ? "guest" : "owner";
  const calls: { path: string; method: string }[] = [];
  (globalThis as { __LYX_SEARCH_CALLS__?: typeof calls }).__LYX_SEARCH_CALLS__ = calls;
  let moreFailed = false;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    calls.push({ path, method: options?.method ?? "GET" });
    const url = new URL(path, "http://local");
    if (url.pathname === "/m/mall-config") return searchConfig as T;
    if (url.pathname !== "/m/dramas/search") throw new Error(`未登记搜索场景请求：${url.pathname}`);
    if (scene === "search-error") throw new Error("网络异常，请检查网络后重试");
    const more = url.searchParams.has("cursor");
    if (scene === "search-more" && more && !moreFailed) {
      moreFailed = true;
      throw new Error("暂时无法加载更多，请重试");
    }
    const result = searchPage(role, {
      ids:
        scene === "search-empty"
          ? []
          : scene === "search-more"
            ? more
              ? [20, 21, 22, 23, 24]
              : Array.from({ length: 20 }, (_, i) => i + 1)
            : undefined,
      mode: scene === "search-fallback" ? "industry_fallback" : "match",
      hasMore: scene === "search-more" && !more,
      fields:
        scene === "search-fallback"
          ? []
          : role === "clerk"
            ? ["genre"]
            : role === "guest"
              ? ["cast"]
              : ["title"],
    });
    const q = url.searchParams.get("q") ?? "";
    const cards: SearchCard[] = result.items;
    const display = {
      ...result,
      items: cards.map((item) => ({
        ...item,
        title:
          role === "owner" && result.mode === "match" && !item.title.includes(q)
            ? `${q}·${item.title}`
            : item.title,
      })),
    };
    return (scene === "search-empty" ? { ...display, totalApprox: 0 } : display) as T;
  };
}
