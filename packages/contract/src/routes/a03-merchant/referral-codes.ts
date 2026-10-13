// 后台：商家、资质审核与素材复核 · referral-codes（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  ReferralCodeListQuerySchema,
  ReferralCodeListSchema,
  ReferralCodeCreateBodySchema,
  ReferralCodeRowSchema,
  ReferralCodeParamsSchema,
  ReferralCodeDisableBodySchema,
  ReferralCodeEnableBodySchema,
} from "./referral-codes.schemas.js";

export const adminReferralCodeList = adminRoute({
  method: "get",
  path: "/admin/referral-codes",
  operationId: "admin.referralCode.list",
  summary: "渠道码与邀请码登记列表",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: ReferralCodeListQuerySchema },
  responses: { ...okResponse(ReferralCodeListSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminReferralCodeCreate = adminRoute({
  method: "post",
  path: "/admin/referral-codes",
  operationId: "admin.referralCode.create",
  summary: "登记渠道码（销售、活动）",
  "x-permission": "merchant.referral_code.manage",
  "x-idempotent": "required",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ReferralCodeCreateBodySchema } },
    },
  },
  responses: { ...okResponse(ReferralCodeRowSchema), ...errorResponses(400, 401, 403, 409) },
});

export const adminReferralCodeDisable = adminRoute({
  method: "post",
  path: "/admin/referral-codes/{referralCodeId}/disable",
  operationId: "admin.referralCode.disable",
  summary: "停用渠道码（停用后不再归因）",
  "x-permission": "merchant.referral_code.manage",
  "x-idempotent": "required",
  request: {
    params: ReferralCodeParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: ReferralCodeDisableBodySchema } },
    },
  },
  responses: { ...okResponse(ReferralCodeRowSchema), ...errorResponses(400, 401, 403, 404, 409) },
});

export const adminReferralCodeEnable = adminRoute({
  method: "post",
  path: "/admin/referral-codes/{referralCodeId}/enable",
  operationId: "admin.referralCode.enable",
  summary: "重新启用渠道码",
  "x-permission": "merchant.referral_code.manage",
  "x-idempotent": "required",
  request: {
    params: ReferralCodeParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: ReferralCodeEnableBodySchema } },
    },
  },
  responses: { ...okResponse(ReferralCodeRowSchema), ...errorResponses(400, 401, 403, 404, 409) },
});
