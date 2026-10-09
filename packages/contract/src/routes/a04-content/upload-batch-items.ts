// 后台：短剧库与积分价 · upload-batch-items（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";

import {
  UploadBatchDetailSchema,
  UploadBatchEmptyBodySchema,
  UploadBatchItemParamsSchema,
  UploadBatchItemSchema,
  UploadBatchItemUpdateBodySchema,
} from "./upload-batches.schemas.js";

export const adminUploadBatchItemUpdate = adminRoute({
  method: "patch",
  path: "/admin/upload-batch-items/{uploadBatchItemId}",
  operationId: "admin.uploadBatchItem.update",
  summary: "修改批次条目：集号映射、跳过（仅 partial 批次）、同一集换新文件",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  request: {
    params: UploadBatchItemParamsSchema,
    body: { content: { "application/json": { schema: UploadBatchItemUpdateBodySchema } } },
  },
  responses: {
    ...okResponse(UploadBatchDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminUploadBatchItemComplete = adminRoute({
  method: "post",
  path: "/admin/upload-batch-items/{uploadBatchItemId}/complete",
  operationId: "admin.uploadBatchItem.complete",
  "x-three-phase": true,
  summary: "批次内单个文件上传完成确认",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  request: {
    params: UploadBatchItemParamsSchema,
    body: { content: { "application/json": { schema: UploadBatchEmptyBodySchema } } },
  },
  responses: {
    ...okResponse(UploadBatchItemSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});
