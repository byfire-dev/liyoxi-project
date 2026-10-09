// 后台：短剧库与积分价（docs/api/a04-content.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as dramaEpisodes from "./drama-episodes.js";
import * as dramaPermits from "./drama-permits.js";
import * as dramaPriceRevisions from "./drama-price-revisions.js";
import * as dramaPrices from "./drama-prices.js";
import * as dramas from "./dramas.js";
import * as priceTierRevisions from "./price-tier-revisions.js";
import * as uploadBatchItems from "./upload-batch-items.js";
import * as uploadBatches from "./upload-batches.js";

export const A04_CONTENT = defineRouteDoc("a04-content", [
  dramaEpisodes,
  dramaPermits,
  dramaPriceRevisions,
  dramaPrices,
  dramas,
  priceTierRevisions,
  uploadBatchItems,
  uploadBatches,
]);

export {
  adminDramaConfirmPermitRecheck,
  adminDramaCopyrightReplace,
  adminDramaDramaCopyrightRevisionCreate,
  adminDramaDramaPriceRevisionCreate,
} from "./dramas.js";
export { adminDramaPriceList, adminDramaPriceSummary } from "./drama-prices.js";
export {
  adminDramaPriceRevisionList,
  adminDramaPriceRevisionWithdraw,
} from "./drama-price-revisions.js";
export { adminPriceTierRevisionList } from "./price-tier-revisions.js";
export * from "./drama-copyright.schemas.js";
export * from "./drama-pricing.schemas.js";
export * from "./upload-batches.js";
export * from "./upload-batch-items.js";
export * from "./upload-batches.schemas.js";
