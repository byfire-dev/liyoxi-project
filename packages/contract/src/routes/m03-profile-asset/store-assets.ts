// 商家端：门店档案、资质与素材 · store-assets（docs/api/m03-profile-asset.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantRoute } from "../builders.js";
import { z } from "../../zod.js";
import { errorResponses, okResponse, cursorPage } from "../../common/index.js";

import {
  AssetFeedbackBodySchema,
  AssetPathSchema,
  PortraitAuthBodySchema,
  StoreAssetCardSchema,
  StoreAssetCreateBodySchema,
  StoreAssetDetailSchema,
  StoreAssetListQuerySchema,
  StoreAssetSummaryQuerySchema,
  StoreAssetSummarySchema,
} from "./store-assets.schemas.js";

export const mStoreAssetList = merchantRoute({
  method: "get",
  path: "/m/store-assets",
  operationId: "m.storeAsset.list",
  summary:
    "门店素材列表（游标分页，按上传时间倒序）：?tab=（素材类型页签）&status=&tag=&q=&uploader=me&isSelectableAsReference=&assetDemandId=&ids=；卡片含缩略图、角标、标题、状态、上传人与角色、引文、标签",
  "x-capability": "asset.read",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: StoreAssetListQuerySchema },
  responses: {
    ...okResponse(cursorPage(StoreAssetCardSchema)),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mStoreAssetCreate = merchantRoute({
  method: "post",
  path: "/m/store-assets",
  operationId: "m.storeAsset.create",
  summary:
    "创建门店素材：{type, fileIds[], textBody?, contentTagCodes[], note?, assetDemandId?}，并投递理解任务（转写、识别、提炼）",
  "x-capability": "asset.upload",
  "x-clerk-view": "same",
  "x-idempotent": "required",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: StoreAssetCreateBodySchema } },
    },
  },
  "x-redact-on-replay": ["thumbnail"],
  responses: {
    ...okResponse(StoreAssetCardSchema.extend({ replayed: z.boolean() })),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mStoreAssetSummary = merchantRoute({
  method: "get",
  path: "/m/store-assets/summary",
  operationId: "m.storeAsset.summary",
  summary:
    "素材库计数：各类型页签计数、整理中数量、热门标签；带 uploader=me 时给“我上传的 N 条 · M 条被采用”",
  "x-capability": "asset.read",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: StoreAssetSummaryQuerySchema },
  responses: {
    ...okResponse(StoreAssetSummarySchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mStoreAssetGet = merchantRoute({
  method: "get",
  path: "/m/store-assets/{storeAssetId}",
  operationId: "m.storeAsset.get",
  summary:
    "素材详情：文件签名地址、转写全文、要点、分维度标签（内容/用途/时效/可用性）、复核人与时间、使用记录",
  "x-capability": "asset.read",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { params: AssetPathSchema },
  responses: {
    ...okResponse(StoreAssetDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mStoreAssetFeedbackCreate = merchantRoute({
  method: "post",
  path: "/m/store-assets/{storeAssetId}/feedback",
  operationId: "m.storeAsset.feedback.create",
  summary: "素材标签有误等轻量反馈（反馈内容，≤200 字）；写审计并通知交付经理",
  "x-capability": "asset.feedback",
  "x-clerk-view": "same",
  "x-idempotent": "required",
  request: {
    params: AssetPathSchema,
    body: { required: true, content: { "application/json": { schema: AssetFeedbackBodySchema } } },
  },
  responses: { ...okResponse(z.null()), ...errorResponses(400, 401, 403, 404, 409, 503) },
});

export const mStoreAssetPortraitAuthCreate = merchantRoute({
  method: "post",
  path: "/m/store-assets/{storeAssetId}/portrait-auth",
  operationId: "m.storeAsset.portraitAuth.create",
  summary: "为“需肖像授权”的素材补交授权材料（fileIds）",
  "x-capability": "asset.upload",
  "x-clerk-view": "same",
  "x-idempotent": "required",
  request: {
    params: AssetPathSchema,
    body: { required: true, content: { "application/json": { schema: PortraitAuthBodySchema } } },
  },
  "x-redact-on-replay": ["thumbnail", "files[].url", "files[].expiresAt", "files[].coverUrl"],
  responses: {
    ...okResponse(StoreAssetDetailSchema.extend({ replayed: z.boolean() })),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});
