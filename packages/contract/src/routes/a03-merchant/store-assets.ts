// 后台：商家、资质审核与素材复核 · store-assets（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { errorResponses, okResponse } from "../../common/index.js";
import { adminPage } from "../a01-system/structures.js";

import {
  AssetPathSchema,
  PortraitAuthBodySchema,
} from "../m03-profile-asset/store-assets.schemas.js";
import {
  AdminStoreAssetConfirmPortraitBodySchema,
  AdminStoreAssetCreateBodySchema,
  AdminStoreAssetDeleteBodySchema,
  AdminStoreAssetDetailSchema,
  AdminStoreAssetListQuerySchema,
  AdminStoreAssetReprocessBodySchema,
  AdminStoreAssetReviewBodySchema,
  AdminStoreAssetRowSchema,
  AdminStoreAssetSummaryQuerySchema,
  AdminStoreAssetSummarySchema,
} from "./store-assets.schemas.js";

export const adminStoreAssetList = adminRoute({
  method: "get",
  path: "/admin/store-assets",
  operationId: "admin.storeAsset.list",
  summary: "门店素材列表：按复核状态（待整理）、是否已采用、类型筛选，按上传时间倒序",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: AdminStoreAssetListQuerySchema },
  responses: {
    ...okResponse(adminPage(AdminStoreAssetRowSchema)),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreAssetCreate = adminRoute({
  method: "post",
  path: "/admin/store-assets",
  operationId: "admin.storeAsset.create",
  summary: "员工代商家上传素材",
  "x-permission": "merchant.asset.upload_on_behalf",
  "x-idempotent": "required",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AdminStoreAssetCreateBodySchema } },
    },
  },
  "x-redact-on-replay": ["thumbnail"],
  responses: {
    ...okResponse(AdminStoreAssetRowSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreAssetSummary = adminRoute({
  method: "get",
  path: "/admin/store-assets/summary",
  operationId: "admin.storeAsset.summary",
  summary: "门店素材计数：按复核状态与类型（商家详情“门店素材”页签角标与类型筛选的计数）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: AdminStoreAssetSummaryQuerySchema },
  responses: {
    ...okResponse(AdminStoreAssetSummarySchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreAssetGet = adminRoute({
  method: "get",
  path: "/admin/store-assets/{storeAssetId}",
  operationId: "admin.storeAsset.get",
  summary: "素材详情：文件组预览地址、系统识别结果（转写、要点、标签、人脸）、使用记录",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: AssetPathSchema },
  responses: {
    ...okResponse(AdminStoreAssetDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreAssetConfirmPortraitAuth = adminRoute({
  method: "post",
  path: "/admin/store-assets/{storeAssetId}/confirm-portrait-auth",
  operationId: "admin.storeAsset.confirmPortraitAuth",
  summary: "确认肖像授权齐全，可用性改为可直接使用或仅供参考",
  "x-permission": "merchant.asset.review",
  "x-idempotent": "required",
  request: {
    params: AssetPathSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminStoreAssetConfirmPortraitBodySchema } },
    },
  },
  "x-redact-on-replay": ["thumbnail", "files.*.url", "files.*.expiresAt", "files.*.coverUrl"],
  responses: {
    ...okResponse(AdminStoreAssetDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreAssetDelete = adminRoute({
  method: "post",
  path: "/admin/store-assets/{storeAssetId}/delete",
  operationId: "admin.storeAsset.delete",
  summary: "后台软删除素材（写 deleted_at，7 天后清除文件；原因必填，写审计）",
  "x-permission": "merchant.asset.review",
  "x-idempotent": "required",
  request: {
    params: AssetPathSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminStoreAssetDeleteBodySchema } },
    },
  },
  responses: { ...okResponse(z.null()), ...errorResponses(400, 401, 403, 404, 409, 503) },
});

export const adminStoreAssetPortraitAuthCreate = adminRoute({
  method: "post",
  path: "/admin/store-assets/{storeAssetId}/portrait-auth",
  operationId: "admin.storeAsset.portraitAuth.create",
  summary: "员工代商家补交肖像授权材料（文件分类 portrait_auth，追加到 portrait_auth_file_ids）",
  "x-permission": "merchant.asset.upload_on_behalf",
  "x-idempotent": "required",
  request: {
    params: AssetPathSchema,
    body: { required: true, content: { "application/json": { schema: PortraitAuthBodySchema } } },
  },
  "x-redact-on-replay": ["thumbnail", "files.*.url", "files.*.expiresAt", "files.*.coverUrl"],
  responses: {
    ...okResponse(AdminStoreAssetDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreAssetReprocess = adminRoute({
  method: "post",
  path: "/admin/store-assets/{storeAssetId}/reprocess",
  operationId: "admin.storeAsset.reprocess",
  summary: "素材重新识别（转写、打标）",
  "x-permission": "merchant.asset.review",
  "x-idempotent": "required",
  request: {
    params: AssetPathSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminStoreAssetReprocessBodySchema } },
    },
  },
  "x-redact-on-replay": ["thumbnail"],
  responses: {
    ...okResponse(AdminStoreAssetRowSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreAssetReview = adminRoute({
  method: "post",
  path: "/admin/store-assets/{storeAssetId}/review",
  operationId: "admin.storeAsset.review",
  summary:
    "整理素材：内容标签、用途、时效、可用性（需补拍、需肖像授权时提醒上传人），带 lockVersion",
  "x-permission": "merchant.asset.review",
  "x-idempotent": "required",
  request: {
    params: AssetPathSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminStoreAssetReviewBodySchema } },
    },
  },
  "x-redact-on-replay": ["thumbnail", "files.*.url", "files.*.expiresAt", "files.*.coverUrl"],
  responses: {
    ...okResponse(AdminStoreAssetDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});
