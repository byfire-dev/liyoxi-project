// 后台：发布与巡检 · metric-submissions（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminMetricSubmissionList = adminMeta({
  method: "get",
  path: "/admin/metric-submissions",
  operationId: "admin.metricSubmission.list",
  summary: "作品数据提交队列（待录入、已录入、已驳回）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminMetricSubmissionApprove = adminMeta({
  method: "post",
  path: "/admin/metric-submissions/{metricSubmissionId}/approve",
  operationId: "admin.metricSubmission.approve",
  summary: "录入 7 项指标并通过（播放量降幅超 30% 时生成巡检任务）",
  "x-permission": "publish.metrics.enter",
  "x-idempotent": "required",
});

export const adminMetricSubmissionReject = adminMeta({
  method: "post",
  path: "/admin/metric-submissions/{metricSubmissionId}/reject",
  operationId: "admin.metricSubmission.reject",
  summary: "驳回数据提交（原因 + 说明）",
  "x-permission": "publish.metrics.enter",
  "x-idempotent": "required",
});
