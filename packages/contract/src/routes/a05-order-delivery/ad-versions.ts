// 后台：订购、取消、交付与广告任务 · ad-versions（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  AdminAdVersionParamSchema,
  AdEmptyBodySchema,
  AdVersionPushBodySchema,
  AdminAdVersionViewSchema,
  AdTaskDetailSchema,
} from "./admin-ads.schemas.js";

export const adminAdVersionMarkSent = adminRoute({
  request: {
    params: AdminAdVersionParamSchema,
    body: { required: true, content: { "application/json": { schema: AdEmptyBodySchema } } },
  },
  responses: {
    ...okResponse(AdminAdVersionViewSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  "x-redact-on-replay": ["preview"],
  method: "post",
  path: "/admin/ad-versions/{adVersionId}/mark-sent",
  operationId: "admin.adVersion.markSent",
  summary: "登记已经企业微信向老板发送广告版本（写 offline_sent_at 与发送人；广告视频不加水印）",
  "x-permission": "delivery.sample.push",
  "x-idempotent": "required",
});

export const adminAdVersionPush = adminRoute({
  request: {
    params: AdminAdVersionParamSchema,
    body: { required: true, content: { "application/json": { schema: AdVersionPushBodySchema } } },
  },
  responses: { ...okResponse(AdTaskDetailSchema), ...errorResponses(400, 401, 403, 404, 409, 503) },
  "x-redact-on-replay": [
    "versions[].preview",
    "revisions[].screenshots",
    "referenceFiles[].thumbnail",
  ],
  method: "post",
  path: "/admin/ad-versions/{adVersionId}/push",
  operationId: "admin.adVersion.push",
  summary:
    "推送广告版本给商家确认（确定查看方式 previewChannels；不可在小程序内播放时须已线下提供）",
  "x-permission": "delivery.ad.upload",
  "x-idempotent": "required",
});
