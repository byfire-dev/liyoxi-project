import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type SearchPage = Data<"m.drama.search">;
export type SearchCard = SearchPage["items"][number];
export type SearchConfig = Data<"m.mallConfig.get">;
export function createSearchApi(send: RequestLayer["request"]) {
  return {
    config: () => send<SearchConfig>("/m/mall-config"),
    search: (q: string, cursor: string | null = null) =>
      send<SearchPage>(
        `/m/dramas/search?q=${encodeURIComponent(q)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
  };
}
export type SearchApi = ReturnType<typeof createSearchApi>;
