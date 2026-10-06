import { WEAPP_PAGES } from "../pages";

export interface ReturnPage {
  route: string;
  query?: Record<string, unknown>;
}
export function returnTarget(page: ReturnPage | null): { url: string; tab: boolean } {
  const found = WEAPP_PAGES.find(
    (item) => item.route === page?.route && (item.implemented || item.placeholder),
  );
  if (!found || found.route === "pages/login/index") return { url: "/pages/mine/index", tab: true };
  const query = Object.entries(page?.query ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return {
    url: `/${found.route}${query && !found.tab ? `?${query}` : ""}`,
    tab: found.tab === true,
  };
}
