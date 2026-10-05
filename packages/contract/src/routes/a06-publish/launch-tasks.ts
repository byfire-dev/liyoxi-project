// 后台：发布与巡检 · launch-tasks（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminLaunchTaskList = adminMeta({
  method: "get",
  path: "/admin/launch-tasks",
  operationId: "admin.launchTask.list",
  summary: "上线任务查询：逾期未上线（任务粒度，带跟进时间线）、7 日内待上线（可仅看成片已交付）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminLaunchTaskSummary = adminMeta({
  method: "get",
  path: "/admin/launch-tasks/summary",
  operationId: "admin.launchTask.summary",
  summary:
    "逾期跟踪指标卡：逾期未上线、7 日内待上线、7 日内成片交付中、近 30 天逾期（平均逾期天数、已上线数）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
