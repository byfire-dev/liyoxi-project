// 后台：商家、资质审核与素材复核 · asset-demands（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { errorResponses, okResponse } from "../../common/index.js";
import { adminPage } from "../a01-system/structures.js";

import { AssetDemandPathSchema } from "../m03-profile-asset/store-assets.schemas.js";
import {
  AdminAssetDemandCancelBodySchema,
  AdminAssetDemandCreateBodySchema,
  AdminAssetDemandListQuerySchema,
  AdminAssetDemandRowSchema,
} from "./store-assets.schemas.js";

export const adminAssetDemandList = adminRoute({
  method: "get",
  path: "/admin/asset-demands",
  operationId: "admin.assetDemand.list",
  summary: "素材需求列表（门店素材页签上方）：标题、说明、发起人、完成时间、已收到条数、状态",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: AdminAssetDemandListQuerySchema },
  responses: {
    ...okResponse(adminPage(AdminAssetDemandRowSchema)),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminAssetDemandCreate = adminRoute({
  method: "post",
  path: "/admin/asset-demands",
  operationId: "admin.assetDemand.create",
  summary: "发起素材需求（名称、拍摄说明、完成日期、通知对象），通知老板与店员",
  "x-permission": "merchant.asset.demand.create",
  "x-idempotent": "required",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AdminAssetDemandCreateBodySchema } },
    },
  },
  responses: {
    ...okResponse(AdminAssetDemandRowSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminAssetDemandCancel = adminRoute({
  method: "post",
  path: "/admin/asset-demands/{assetDemandId}/cancel",
  operationId: "admin.assetDemand.cancel",
  summary: "撤销素材需求",
  "x-permission": "merchant.asset.demand.create",
  "x-idempotent": "required",
  request: {
    params: AssetDemandPathSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminAssetDemandCancelBodySchema } },
    },
  },
  responses: {
    ...okResponse(AdminAssetDemandRowSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminAssetDemandComplete = adminRoute({
  method: "post",
  path: "/admin/asset-demands/{assetDemandId}/complete",
  operationId: "admin.assetDemand.complete",
  summary: "标记素材需求完成",
  "x-permission": "merchant.asset.demand.create",
  "x-idempotent": "required",
  request: {
    params: AssetDemandPathSchema,
    body: { required: true, content: { "application/json": { schema: z.strictObject({}) } } },
  },
  responses: {
    ...okResponse(AdminAssetDemandRowSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});
