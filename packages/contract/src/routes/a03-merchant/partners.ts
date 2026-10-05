// 后台：商家、资质审核与素材复核 · partners（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPartnerList = adminMeta({
  method: "get",
  path: "/admin/partners",
  operationId: "admin.partner.list",
  summary: "服务商列表（区域、等级、状态；名下商家、本月名下实付、返佣）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPartnerGet = adminMeta({
  method: "get",
  path: "/admin/partners/{partnerId}",
  operationId: "admin.partner.get",
  summary: "服务商详情与本月成交前三的商家",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPartnerAdjustLevel = adminMeta({
  method: "post",
  path: "/admin/partners/{partnerId}/adjust-level",
  operationId: "admin.partner.adjustLevel",
  summary: "手动调整服务商等级（须填原因）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminPartnerPause = adminMeta({
  method: "post",
  path: "/admin/partners/{partnerId}/pause",
  operationId: "admin.partner.pause",
  summary: "暂停合作（须填原因，通知服务商）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminPartnerResume = adminMeta({
  method: "post",
  path: "/admin/partners/{partnerId}/resume",
  operationId: "admin.partner.resume",
  summary: "恢复合作",
  "x-permission": null,
  "x-idempotent": "required",
});
