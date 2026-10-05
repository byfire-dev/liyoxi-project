// 后台：发布与巡检 · channel-account-submissions（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminChannelAccountSubmissionGet = adminMeta({
  method: "get",
  path: "/admin/channel-account-submissions/{channelAccountSubmissionId}",
  operationId: "admin.channelAccountSubmission.get",
  summary: "账号核验详情：填报信息与截图比对表、历次核验记录、审批单引用",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminChannelAccountSubmissionApprove = adminMeta({
  method: "post",
  path: "/admin/channel-account-submissions/{channelAccountSubmissionId}/approve",
  operationId: "admin.channelAccountSubmission.approve",
  summary: "账号核验通过（比对表没有不一致项；填写账号类型）",
  "x-permission": "publish.account.verify",
  "x-idempotent": "required",
});

export const adminChannelAccountSubmissionReject = adminMeta({
  method: "post",
  path: "/admin/channel-account-submissions/{channelAccountSubmissionId}/reject",
  operationId: "admin.channelAccountSubmission.reject",
  summary: "账号核验驳回（原画板“标记异常”）：原因（字典）与说明必填",
  "x-permission": "publish.account.verify",
  "x-idempotent": "required",
});
