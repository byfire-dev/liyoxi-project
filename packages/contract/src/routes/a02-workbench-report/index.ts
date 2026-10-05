// 后台：工作台、报表与导出（docs/api/a02-workbench-report.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as exportJobs from "./export-jobs.js";
import * as navBadges from "./nav-badges.js";
import * as reportMonthCloses from "./report-month-closes.js";
import * as reports from "./reports.js";
import * as search from "./search.js";
import * as staffMessages from "./staff-messages.js";
import * as workbench from "./workbench.js";

export const A02_WORKBENCH_REPORT = defineRouteDoc("a02-workbench-report", [
  exportJobs,
  navBadges,
  reportMonthCloses,
  reports,
  search,
  staffMessages,
  workbench,
]);
