// 后台：订购、取消、交付与广告任务（docs/api/a05-order-delivery.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as adVersions from "./ad-versions.js";
import * as ads from "./ads.js";
import * as cancelRequests from "./cancel-requests.js";
import * as deliveryPlans from "./delivery-plans.js";
import * as deliveryTickets from "./delivery-tickets.js";
import * as licenseLetterRevisions from "./license-letter-revisions.js";
import * as licenseLetters from "./license-letters.js";
import * as orderItems from "./order-items.js";
import * as orders from "./orders.js";
import * as productionRecords from "./production-records.js";
import * as reissues from "./reissues.js";
import * as samples from "./samples.js";

export const A05_ORDER_DELIVERY = defineRouteDoc("a05-order-delivery", [
  adVersions,
  ads,
  cancelRequests,
  deliveryPlans,
  deliveryTickets,
  licenseLetterRevisions,
  licenseLetters,
  orderItems,
  orders,
  productionRecords,
  reissues,
  samples,
]);
