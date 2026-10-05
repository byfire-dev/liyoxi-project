// 后台：工作台、报表与导出 · workbench（docs/api/a02-workbench-report.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminWorkbenchAlertGet = adminMeta({
  method: "get",
  path: "/admin/workbench/alerts",
  operationId: "admin.workbench.alert.get",
  summary: "预警：超时工单、逾期未上线、逾期未下架、版权即将到期，每条带跳转目标",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminWorkbenchFeedList = adminMeta({
  method: "get",
  path: "/admin/workbench/feed",
  operationId: "admin.workbench.feed.list",
  summary:
    "实时动态：按时间倒序的审计日志活动流（ops、activity 两流中与商家相关的行），游标分页带 totalApprox",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminWorkbenchTodayGet = adminMeta({
  method: "get",
  path: "/admin/workbench/today",
  operationId: "admin.workbench.today.get",
  summary:
    "今日数据卡片：新增商家、今日订购与冻结积分、今日收款、套餐生效商家（带“数据更新于”时间）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminWorkbenchTodoGet = adminMeta({
  method: "get",
  path: "/admin/workbench/todos",
  operationId: "admin.workbench.todo.get",
  summary: "我的待办：按岗位视角聚合各队列计数与一条副指标（最早时间、金额合计、最近截止、超时数）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
