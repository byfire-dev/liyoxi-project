/** 详情写侧的独立增量场景；H5不证明原生授权或真实云内容。 */
export const ASSET_ACTION_SCENES = [
  "asset-action-feedback-owner",
  "asset-action-feedback-limit-clerk",
  "asset-action-portrait-success-owner",
  "asset-action-portrait-partial-owner",
  "asset-action-portrait-unknown-owner",
  "asset-action-denied-clerk",
].map((name) => ({
  name,
  route: "sub/asset/detail/index?storeAssetId=019aa000-0000-7000-8000-000000000001",
}));
