// 电脑端下载页（docs/api/p01-portal.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as ads from "./ads.js";
import * as clientErrors from "./client-errors.js";
import * as files from "./files.js";
import * as licenseVerifications from "./license-verifications.js";
import * as orderItems from "./order-items.js";
import * as portalTickets from "./portal-tickets.js";
import * as samples from "./samples.js";
import * as sessions from "./sessions.js";

export const P01_PORTAL = defineRouteDoc("p01-portal", [
  ads,
  clientErrors,
  files,
  licenseVerifications,
  orderItems,
  portalTickets,
  samples,
  sessions,
]);
