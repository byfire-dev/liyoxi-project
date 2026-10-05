// 后台：内容运营与通知配置（docs/api/a09-ops.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as agreementConsents from "./agreement-consents.js";
import * as agreementVersions from "./agreement-versions.js";
import * as agreements from "./agreements.js";
import * as faqs from "./faqs.js";
import * as homeBanners from "./home-banners.js";
import * as notices from "./notices.js";
import * as notificationDeliveries from "./notification-deliveries.js";
import * as notifyScenes from "./notify-scenes.js";
import * as siteConfigs from "./site-configs.js";
import * as siteNotices from "./site-notices.js";
import * as smsTemplates from "./sms-templates.js";
import * as wxTemplateSlots from "./wx-template-slots.js";

export const A09_OPS = defineRouteDoc("a09-ops", [
  agreementConsents,
  agreementVersions,
  agreements,
  faqs,
  homeBanners,
  notices,
  notificationDeliveries,
  notifyScenes,
  siteConfigs,
  siteNotices,
  smsTemplates,
  wxTemplateSlots,
]);
