// 后台：发布与巡检（docs/api/a06-publish.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as channelAccountSubmissions from "./channel-account-submissions.js";
import * as channelAccounts from "./channel-accounts.js";
import * as deliveryReleases from "./delivery-releases.js";
import * as deliveryTickets from "./delivery-tickets.js";
import * as launchCalendar from "./launch-calendar.js";
import * as launchSubmissions from "./launch-submissions.js";
import * as launchTasks from "./launch-tasks.js";
import * as metricImports from "./metric-imports.js";
import * as metricSubmissions from "./metric-submissions.js";
import * as patrolTasks from "./patrol-tasks.js";
import * as takedownTasks from "./takedown-tasks.js";

export const A06_PUBLISH = defineRouteDoc("a06-publish", [
  channelAccountSubmissions,
  channelAccounts,
  deliveryReleases,
  deliveryTickets,
  launchCalendar,
  launchSubmissions,
  launchTasks,
  metricImports,
  metricSubmissions,
  patrolTasks,
  takedownTasks,
]);

export * from "./publish.schemas.js";
export * from "./channel-account-submissions.js";
export * from "./channel-accounts.js";
export * from "./launch-submissions.js";
export * from "./error-details.js";
export { adminDeliveryReleaseGet } from "./delivery-releases.js";
export * from "./delivery-release.schemas.js";
