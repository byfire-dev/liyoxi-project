// 商家端：门店档案、资质与素材（docs/api/m03-profile-asset.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as assetDemands from "./asset-demands.js";
import * as qualificationDocs from "./qualification-docs.js";
import * as qualificationSubmissions from "./qualification-submissions.js";
import * as storeAssets from "./store-assets.js";
import * as storeProfile from "./store-profile.js";

export const M03_PROFILE_ASSET = defineRouteDoc("m03-profile-asset", [
  assetDemands,
  qualificationDocs,
  qualificationSubmissions,
  storeAssets,
  storeProfile,
]);

export * from "./error-details.js";

export * from "./profile.schemas.js";
export * from "./qualification.schemas.js";
export * from "./store-profile.js";
export * from "./qualification-docs.js";

export * from "./store-assets.schemas.js";

export * from "./store-assets.js";

export * from "./asset-demands.js";
