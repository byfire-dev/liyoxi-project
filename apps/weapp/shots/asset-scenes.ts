/** 只读素材 H5 场景；不作为原生播放或真实云验收。 */
export const ASSET_SCENES = [
  { name: "asset-lib-owner", route: "sub/asset/lib/index" },
  { name: "asset-lib-clerk", route: "sub/asset/lib/index" },
  { name: "asset-lib-loading", route: "sub/asset/lib/index" },
  { name: "asset-lib-empty", route: "sub/asset/lib/index" },
  { name: "asset-lib-filter-empty", route: "sub/asset/lib/index" },
  { name: "asset-lib-error", route: "sub/asset/lib/index" },
  { name: "asset-lib-more-error", route: "sub/asset/lib/index" },
  {
    name: "asset-detail-image",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-video",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-recording",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-audio",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-document",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-text",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-partial",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-organizing",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-missing",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
  {
    name: "asset-detail-error",
    route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
  },
] as const;
