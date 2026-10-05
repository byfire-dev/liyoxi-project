// 后台：登录、员工、权限与系统 · calendar-days（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminCalendarDayList = adminMeta({
  method: "get",
  path: "/admin/calendar-days",
  operationId: "admin.calendarDay.list",
  summary: "某年的工作日历（放假、调休上班），参数页的节假日表",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCalendarDayBatchImport = adminMeta({
  method: "post",
  path: "/admin/calendar-days/import",
  operationId: "admin.calendarDay.batchImport",
  summary: "导入年度放假安排（按年幂等；有变化才升日历批次并重算各类工作日时限）",
  "x-permission": "sys.param.edit",
  "x-idempotent": "required",
});
