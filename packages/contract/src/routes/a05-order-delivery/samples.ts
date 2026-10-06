// 后台：订购、取消、交付与广告任务 · samples（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminSampleInspect = adminRoute({
  method: "post",
  path: "/admin/samples/{sampleId}/inspect",
  operationId: "admin.sample.inspect",
  summary: "样片质检：逐项清单结果，通过或不通过（注明原因）",
  "x-permission": "delivery.sample.qc",
  "x-idempotent": "required",
  request: {
    params: SampleParamSchema,
    body: { required: true, content: { "application/json": { schema: SampleInspectBodySchema } } },
  },
  responses: {
    ...okResponse(AdminSampleWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
  "x-redact-on-replay": ["preview", "decision.feedbackImages"],
});

export const adminSampleMarkSent = adminMeta({
  method: "post",
  path: "/admin/samples/{sampleId}/mark-sent",
  operationId: "admin.sample.markSent",
  summary: "登记已经企业微信向老板发送样片水印版（写 offline_sent_at 与发送人）",
  "x-permission": "delivery.sample.push",
  "x-idempotent": "required",
});

export const adminSamplePush = adminRoute({
  method: "post",
  path: "/admin/samples/{sampleId}/push",
  operationId: "admin.sample.push",
  summary:
    "推送样片给商家确认（previewChannels：小程序不播放时提供水印版存相册、电脑端或企业微信）",
  "x-permission": "delivery.sample.push",
  "x-idempotent": "required",
  request: {
    params: SampleParamSchema,
    body: { required: true, content: { "application/json": { schema: SamplePushBodySchema } } },
  },
  responses: {
    ...okResponse(AdminSampleWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
  "x-redact-on-replay": ["preview", "decision.feedbackImages"],
});

export const adminSampleRequestChange = adminMeta({
  method: "post",
  path: "/admin/samples/{sampleId}/request-change",
  operationId: "admin.sample.requestChange",
  summary:
    "交付经理代录修改意见：合成问题（不计次，退回样片制作）或广告内容（计入广告修改次数，退回广告准备）",
  "x-permission": "delivery.sample.feedback_on_behalf",
  "x-idempotent": "required",
});

import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  SampleParamSchema,
  SampleInspectBodySchema,
  SamplePushBodySchema,
  AdminSampleWriteResultSchema,
} from "./production.schemas.js";
