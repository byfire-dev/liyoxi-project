/** W3-13：固定离线搜索态，不作为真实 API/微信证据。 */
export const SEARCH_SCENES = [
  { name: "search-idle", route: "sub/catalog/search/index" },
  { name: "search-owner", route: "sub/catalog/search/index" },
  { name: "search-clerk", route: "sub/catalog/search/index" },
  { name: "search-guest", route: "sub/catalog/search/index" },
  { name: "search-fallback", route: "sub/catalog/search/index" },
  { name: "search-empty", route: "sub/catalog/search/index" },
  { name: "search-error", route: "sub/catalog/search/index" },
  { name: "search-more", route: "sub/catalog/search/index" },
] as const;
