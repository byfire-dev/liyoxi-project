export const AD_SCENES = [
  ...["ad-list", "ad-empty", "ad-create", "ad-error", "ad-clerk"].map((name) => ({
    name,
    route: "sub/ad/ads/index",
  })),
  ...["ad-detail", "ad-no-evidence", "ad-change-paid", "ad-returned", "ad-stale"].map((name) => ({
    name,
    route: "sub/ad/ad-detail/index?adId=00000000-0000-4000-8000-000000000801",
  })),
  { name: "ad-mine", route: "pages/mine/index" },
  { name: "ad-profile", route: "sub/profile/profile/index" },
] as const;
