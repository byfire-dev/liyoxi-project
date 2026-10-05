// 后台：商家、资质审核与素材复核 · partner-applications（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPartnerApplicationList = adminMeta({
  method: "get",
  path: "/admin/partner-applications",
  operationId: "admin.partnerApplication.list",
  summary: "服务商入驻申请队列",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPartnerApplicationGet = adminMeta({
  method: "get",
  path: "/admin/partner-applications/{partnerApplicationId}",
  operationId: "admin.partnerApplication.get",
  summary: "入驻申请详情（证照比对、申请信息）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPartnerApplicationApprove = adminMeta({
  method: "post",
  path: "/admin/partner-applications/{partnerApplicationId}/approve",
  operationId: "admin.partnerApplication.approve",
  summary: "入驻审核通过（指派渠道运营，推送合作协议在线签署）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminPartnerApplicationReject = adminMeta({
  method: "post",
  path: "/admin/partner-applications/{partnerApplicationId}/reject",
  operationId: "admin.partnerApplication.reject",
  summary: "驳回入驻申请（原因 + 说明）",
  "x-permission": null,
  "x-idempotent": "required",
});
