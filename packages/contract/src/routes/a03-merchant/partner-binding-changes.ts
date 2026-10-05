// 后台：商家、资质审核与素材复核 · partner-binding-changes（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPartnerBindingChangeList = adminMeta({
  method: "get",
  path: "/admin/partner-binding-changes",
  operationId: "admin.partnerBindingChange.list",
  summary: "归属变更申请列表",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPartnerBindingChangeApprove = adminMeta({
  method: "post",
  path: "/admin/partner-binding-changes/{partnerBindingChangeId}/approve",
  operationId: "admin.partnerBindingChange.approve",
  summary: "通过归属变更（次日 00:00 生效，通知三方）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminPartnerBindingChangeReject = adminMeta({
  method: "post",
  path: "/admin/partner-binding-changes/{partnerBindingChangeId}/reject",
  operationId: "admin.partnerBindingChange.reject",
  summary: "驳回归属变更（须填原因）",
  "x-permission": null,
  "x-idempotent": "required",
});
