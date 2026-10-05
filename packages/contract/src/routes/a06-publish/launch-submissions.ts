// 后台：发布与巡检 · launch-submissions（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminLaunchSubmissionGet = adminMeta({
  method: "get",
  path: "/admin/launch-submissions/{launchSubmissionId}",
  operationId: "admin.launchSubmission.get",
  summary: "链接核验详情：回填链接与截图、核验清单、本轮与历次核验记录、审批单引用",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminLaunchSubmissionApprove = adminMeta({
  method: "post",
  path: "/admin/launch-submissions/{launchSubmissionId}/approve",
  operationId: "admin.launchSubmission.approve",
  summary: "链接核验通过（清单 launch.verify 全部通过；首个账号通过时写使用期起始日）",
  "x-permission": "publish.link.verify",
  "x-idempotent": "required",
});

export const adminLaunchSubmissionReject = adminMeta({
  method: "post",
  path: "/admin/launch-submissions/{launchSubmissionId}/reject",
  operationId: "admin.launchSubmission.reject",
  summary: "链接核验退回修改：原因（字典 reject_reason，场景 link_verify）至少 1 项 + 说明",
  "x-permission": "publish.link.verify",
  "x-idempotent": "required",
});

export const adminLaunchSubmissionRevoke = adminMeta({
  method: "post",
  path: "/admin/launch-submissions/{launchSubmissionId}/revoke",
  operationId: "admin.launchSubmission.revoke",
  summary: "撤销核验通过（1 个工作日内；无已确认或已核查的下架任务）：重开新一轮核验",
  "x-permission": "publish.link.verify_revoke",
  "x-idempotent": "required",
});
