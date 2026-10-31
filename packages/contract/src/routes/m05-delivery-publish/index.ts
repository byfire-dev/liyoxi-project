// 商家端：交付与发布（docs/api/m05-delivery-publish.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as channelAccounts from "./channel-accounts.js";
import * as deliveryPlans from "./delivery-plans.js";
import * as downloads from "./downloads.js";
import * as launchTasks from "./launch-tasks.js";
import * as licenseLetters from "./license-letters.js";
import * as orderItems from "./order-items.js";
import * as performanceReports from "./performance-reports.js";
import * as performanceUploads from "./performance-uploads.js";
import * as samples from "./samples.js";
import * as takedownTasks from "./takedown-tasks.js";

export const M05_DELIVERY_PUBLISH = defineRouteDoc("m05-delivery-publish", [
  channelAccounts,
  deliveryPlans,
  downloads,
  launchTasks,
  licenseLetters,
  orderItems,
  performanceReports,
  performanceUploads,
  samples,
  takedownTasks,
]);

export * from "./publish.schemas.js";
export * from "./delivery.schemas.js";
export * from "./channel-accounts.js";
export * from "./launch-tasks.js";
export * from "./error-details.js";

export * from "./delivery-plans.js";

export * from "./sample.schemas.js";
export { mSampleConfirm, mSampleRequestChange, mSampleDownloadUrls } from "./samples.js";
export {
  mOrderItemSampleGet,
  mOrderItemReleaseGet,
  mOrderItemDownloadUrls,
} from "./order-items.js";
export * from "./download.schemas.js";

export * from "./license.schemas.js";

export * from "./license-letters.js";
