// 后台：工作台、报表与导出 · report-month-closes（docs/api/a02-workbench-report.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminReportMonthCloseList = adminMeta({
  method: "get",
  path: "/admin/report-month-closes",
  operationId: "admin.reportMonthClose.list",
  summary: "报表月度快照（历史月数据来源与“已结算”标记）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReportMonthCloseReissue = adminMeta({
  method: "post",
  path: "/admin/report-month-closes/{reportMonthCloseId}/reissue",
  operationId: "admin.reportMonthClose.reissue",
  summary: "重出某月快照（续率定稿或口径修正），旧快照置 superseded",
  "x-permission": "report.month_close.reissue",
  "x-idempotent": "required",
});
