/** 独立 H5 样张场景；Node 可直接擦除类型读取，不含运行时依赖。 */
export const PROFILE_SCENES = [
  { name: "profile-normal", route: "sub/profile/profile/index" },
  { name: "basic-normal", route: "sub/profile/basic/index" },
  { name: "store-normal", route: "sub/profile/store/index" },
  { name: "service-normal", route: "sub/profile/service/index" },
  { name: "cert-normal", route: "sub/profile/cert/index" },
  { name: "review-normal", route: "sub/profile/review/index" },
  { name: "profile-not-started", route: "sub/profile/profile/index" },
  { name: "cert-missing", route: "sub/profile/cert/index" },
  { name: "review-rejected", route: "sub/profile/review/index" },
] as const;
