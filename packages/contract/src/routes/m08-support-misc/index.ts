// 商家端：客服、消息与通用接口（docs/api/m08-support-misc.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as analyticsEvents from "./analytics-events.js";
import * as bootstrap from "./bootstrap.js";
import * as clientErrors from "./client-errors.js";
import * as dictItems from "./dict-items.js";
import * as faqs from "./faqs.js";
import * as files from "./files.js";
import * as me from "./me.js";
import * as messages from "./messages.js";
import * as notifySettings from "./notify-settings.js";
import * as serviceManager from "./service-manager.js";
import * as serviceTickets from "./service-tickets.js";
import * as siteNotices from "./site-notices.js";
import * as subscribeResults from "./subscribe-results.js";

export const M08_SUPPORT_MISC = defineRouteDoc("m08-support-misc", [
  analyticsEvents,
  bootstrap,
  clientErrors,
  dictItems,
  faqs,
  files,
  me,
  messages,
  notifySettings,
  serviceManager,
  serviceTickets,
  siteNotices,
  subscribeResults,
]);

export * from "./bootstrap.js";
export * from "./me.js";
export * from "./bootstrap.schemas.js";
export * from "./overview.schemas.js";

export * from "./files.js";
export * from "./files.schemas.js";
export * from "./error-details.js";
export * from "./dict-items.js";
export * from "./dict-items.schemas.js";

export * from "./image.schemas.js";

export * from "./reporting.schemas.js";
export * from "./analytics-events.js";
export * from "./subscribe-results.js";
export * from "./client-errors.js";
