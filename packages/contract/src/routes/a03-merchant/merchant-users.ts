// 后台：商家、资质审核与素材复核 · merchant-users（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  MerchantUserIdParamsSchema,
  MerchantUserStatusBodySchema,
  MerchantUserForceLogoutBodySchema,
  MerchantUserStatusViewSchema,
} from "./merchant-users.schemas.js";

export const adminMerchantUserDisable = adminRoute({
  method: "post",
  path: "/admin/merchant-users/{merchantUserId}/disable",
  operationId: "admin.merchantUser.disable",
  summary: "禁用商家账号（原因必填；吊销全部会话）",
  "x-permission": "merchant.user.disable",
  "x-idempotent": "required",
  request: {
    params: MerchantUserIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: MerchantUserStatusBodySchema } },
    },
  },
  responses: {
    ...okResponse(MerchantUserStatusViewSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

export const adminMerchantUserEnable = adminRoute({
  method: "post",
  path: "/admin/merchant-users/{merchantUserId}/enable",
  operationId: "admin.merchantUser.enable",
  summary: "启用商家账号",
  "x-permission": "merchant.user.disable",
  "x-idempotent": "required",
  request: {
    params: MerchantUserIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: MerchantUserStatusBodySchema } },
    },
  },
  responses: {
    ...okResponse(MerchantUserStatusViewSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

export const adminMerchantUserForceLogout = adminRoute({
  method: "post",
  path: "/admin/merchant-users/{merchantUserId}/force-logout",
  operationId: "admin.merchantUser.forceLogout",
  summary: "强制下线商家账号（吊销会话与下载页会话，关闭静默登录）",
  "x-permission": "merchant.user.force_logout",
  "x-idempotent": "required",
  request: {
    params: MerchantUserIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: MerchantUserForceLogoutBodySchema } },
    },
  },
  responses: {
    ...okResponse(MerchantUserStatusViewSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
