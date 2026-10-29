// 商家端：交付与发布 · samples（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mSampleConfirm = merchantRoute({
  method: "post",
  path: "/m/samples/{sampleId}/confirm",
  operationId: "m.sample.confirm",
  summary: "确认小程序样片 {versionNo, viewedVia: weapp, hasViewed: true}，推进到批量合成",
  "x-capability": "delivery.confirm_sample",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: SampleParamSchema,
    body: { required: true, content: { "application/json": { schema: SampleConfirmBodySchema } } },
  },
  responses: {
    ...okResponse(SampleWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
  "x-redact-on-replay": [
    "playable",
    "decision.feedbackImages[].url",
    "decision.feedbackImages[].expiresAt",
  ],
});

export const mSampleDownloadUrls = merchantRoute({
  method: "post",
  path: "/m/samples/{sampleId}/download-urls",
  operationId: "m.sample.downloadUrls",
  summary: "历史样片相册接口：第一期仅小程序内查看，鉴权及版本校验后拒绝签发",
  "x-capability": "delivery.confirm_sample",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录，避免回放过期地址（A18、A19）",
  "x-rate-limit": "m.sign",
  request: {
    params: SampleParamSchema,
    body: { required: false, content: { "application/json": { schema: z.strictObject({}) } } },
  },
  responses: {
    ...okResponse(DownloadUrlSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 500),
  },
});

export const mSampleRequestChange = merchantMeta({
  method: "post",
  path: "/m/samples/{sampleId}/request-change",
  operationId: "m.sample.requestChange",
  summary: "对样片提出修改意见（合成问题）：{feedbackKind: 'compose', note, imageFileIds?}",
  "x-capability": "delivery.confirm_sample",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { SampleParamSchema } from "../a05-order-delivery/production.schemas.js";
import { SampleConfirmBodySchema, SampleWriteResultSchema } from "./sample.schemas.js";
import { DownloadUrlSchema } from "./download.schemas.js";
import { z } from "../../zod.js";
