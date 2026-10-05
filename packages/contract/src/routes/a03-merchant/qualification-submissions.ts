// 后台：商家、资质审核与素材复核 · qualification-submissions（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminQualificationSubmissionGet = adminMeta({
  method: "get",
  path: "/admin/qualification-submissions/{qualificationSubmissionId}",
  operationId: "admin.qualificationSubmission.get",
  summary:
    "资质提交详情（审核页右栏）：本轮证照与识别字段（脱敏）、系统比对结论、修正记录、历次审核与审批单引用",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminQualificationSubmissionApprove = adminMeta({
  method: "post",
  path: "/admin/qualification-submissions/{qualificationSubmissionId}/approve",
  operationId: "admin.qualificationSubmission.approve",
  summary: "资质审核通过（initial 轮次门店与主体认证生效；change 轮次保持已认证）",
  "x-permission": "merchant.qualification.review",
  "x-idempotent": "required",
});

export const adminQualificationSubmissionReject = adminMeta({
  method: "post",
  path: "/admin/qualification-submissions/{qualificationSubmissionId}/reject",
  operationId: "admin.qualificationSubmission.reject",
  summary:
    "资质驳回或退回补充：原因（字典 reject_reason）+ 说明；可指明被驳回的证照行；可选终局驳回",
  "x-permission": "merchant.qualification.review",
  "x-idempotent": "required",
});

export const adminQualificationSubmissionRejectQuote = adminMeta({
  method: "post",
  path: "/admin/qualification-submissions/{qualificationSubmissionId}/reject-quote",
  operationId: "admin.qualificationSubmission.rejectQuote",
  summary: "终局驳回的影响预览：冻结中的订购、广告将整店取消并退回积分",
  "x-permission": "merchant.qualification.review",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});
