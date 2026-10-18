// 后台：短剧库与积分价 · upload-batches（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";

import {
  BatchUploadCredentialsSchema,
  UploadBatchCommitResultSchema,
  UploadBatchCreateBodySchema,
  UploadBatchDetailSchema,
  UploadBatchEmptyBodySchema,
  UploadBatchParamsSchema,
  UploadBatchStartBodySchema,
} from "./upload-batches.schemas.js";

export const adminUploadBatchCreate = adminRoute({
  method: "post",
  path: "/admin/upload-batches",
  operationId: "admin.uploadBatch.create",
  summary:
    "创建批量上传批次并逐集匹配（原片首次上传、批量替换原片；成片批次同用）：用途、目标、文件清单、范围、替换原因、AI 使用声明",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  request: {
    body: { content: { "application/json": { schema: UploadBatchCreateBodySchema } } },
  },
  responses: {
    ...okResponse(UploadBatchDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminUploadBatchGet = adminRoute({
  method: "get",
  path: "/admin/upload-batches/{uploadBatchId}",
  operationId: "admin.uploadBatch.get",
  summary: "批次详情与逐条进度（前端轮询）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: {
    params: UploadBatchParamsSchema,
  },
  responses: {
    ...okResponse(UploadBatchDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminUploadBatchCancel = adminRoute({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/cancel",
  operationId: "admin.uploadBatch.cancel",
  summary: "取消批次",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  request: {
    params: UploadBatchParamsSchema,
    body: { content: { "application/json": { schema: UploadBatchEmptyBodySchema } } },
  },
  responses: {
    ...okResponse(UploadBatchDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminUploadBatchCommit = adminRoute({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/commit",
  operationId: "admin.uploadBatch.commit",
  summary: "提交原片批次：生成新原片版本，旧版本置 superseded；内容有实质变更时标记许可待重新核验",
  "x-permission": "drama.media.manage",
  "x-idempotent": "required",
  request: {
    params: UploadBatchParamsSchema,
    body: { content: { "application/json": { schema: UploadBatchEmptyBodySchema } } },
  },
  responses: {
    ...okResponse(UploadBatchCommitResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminUploadBatchStart = adminRoute({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/start",
  operationId: "admin.uploadBatch.start",
  summary: "确认匹配结果，开始上传",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  request: {
    params: UploadBatchParamsSchema,
    body: { content: { "application/json": { schema: UploadBatchStartBodySchema } } },
  },
  responses: {
    ...okResponse(UploadBatchDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminUploadBatchRefreshCredentials = adminRoute({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/refresh-credentials",
  operationId: "admin.uploadBatch.refreshCredentials",
  summary: "签发或续签整批的直传临时密钥（只能写批次前缀 incoming/b{uploadBatchId}/*，30 分钟）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时凭证，结果不进幂等记录（A18、C47）",
  request: {
    params: UploadBatchParamsSchema,
    body: { content: { "application/json": { schema: UploadBatchEmptyBodySchema } } },
  },
  responses: {
    ...okResponse(BatchUploadCredentialsSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});
