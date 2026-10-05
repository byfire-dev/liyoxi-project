// 后台：商家、资质审核与素材复核 · referral-codes（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminReferralCodeList = adminMeta({
  method: "get",
  path: "/admin/referral-codes",
  operationId: "admin.referralCode.list",
  summary: "渠道码与邀请码登记列表",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReferralCodeCreate = adminMeta({
  method: "post",
  path: "/admin/referral-codes",
  operationId: "admin.referralCode.create",
  summary: "登记渠道码（销售、活动）",
  "x-permission": "merchant.referral_code.manage",
  "x-idempotent": "required",
});

export const adminReferralCodeDisable = adminMeta({
  method: "post",
  path: "/admin/referral-codes/{referralCodeId}/disable",
  operationId: "admin.referralCode.disable",
  summary: "停用渠道码（停用后不再归因）",
  "x-permission": "merchant.referral_code.manage",
  "x-idempotent": "required",
});

export const adminReferralCodeEnable = adminMeta({
  method: "post",
  path: "/admin/referral-codes/{referralCodeId}/enable",
  operationId: "admin.referralCode.enable",
  summary: "重新启用渠道码",
  "x-permission": "merchant.referral_code.manage",
  "x-idempotent": "required",
});
