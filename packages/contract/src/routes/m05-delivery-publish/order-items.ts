// 商家端：交付与发布 · order-items（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mOrderItemDownloadGrantCreate = merchantMeta({
  method: "post",
  path: "/m/order-items/{orderItemId}/download-grants",
  operationId: "m.orderItem.downloadGrant.create",
  summary: "重新生成下载授权（每日至多 5 次），旧授权作废",
  "x-capability": "delivery.download",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mOrderItemDownloadUrls = merchantRoute({
  method: "post",
  path: "/m/order-items/{orderItemId}/download-urls",
  operationId: "m.orderItem.downloadUrls",
  summary:
    "逐集下载 {kind: episode, episodeNo}：校验下载授权，写 delivery_download_log，返回 15 分钟直链与 downloadId",
  "x-capability": "delivery.download",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录，避免回放过期地址（A18、A19）",
  "x-rate-limit": "m.sign",
  request: {
    params: OrderItemDownloadParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: EpisodeDownloadBodySchema } },
    },
  },
  responses: {
    ...okResponse(EpisodeDownloadUrlSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 500),
  },
});

export const mOrderItemPublishListGet = merchantMeta({
  method: "get",
  path: "/m/order-items/{orderItemId}/publish-list",
  operationId: "m.orderItem.publishList.get",
  summary: "发布清单：合集名称、每集标题、话题、简介（供复制）",
  "x-capability": "publish.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mOrderItemReleaseGet = merchantRoute({
  method: "get",
  path: "/m/order-items/{orderItemId}/release",
  operationId: "m.orderItem.release.get",
  summary: "当前成片包：逐集清单（集号、大小、是否有变更）、总大小、下载授权状态与到期时间",
  "x-capability": "delivery.download",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { params: OrderItemDownloadParamSchema },
  responses: { ...okResponse(ReleaseViewSchema), ...errorResponses(400, 401, 403, 404, 500) },
});

export const mOrderItemSampleGet = merchantRoute({
  method: "get",
  path: "/m/order-items/{orderItemId}/sample",
  operationId: "m.orderItem.sample.get",
  summary:
    "样片确认页：当前推送版本、时长、查看方式（preview_channels）、广告位标记（出现时间、类型）、质检摘要；不可在小程序内播放时不返回播放地址，返回查看方式说明",
  "x-capability": "delivery.confirm_sample",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { params: z.strictObject({ orderItemId: IdSchema }) },
  responses: { ...okResponse(SampleViewSchema), ...errorResponses(400, 401, 403, 404, 409, 500) },
});

import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses, IdSchema } from "../../common/index.js";
import { z } from "../../zod.js";
import { SampleViewSchema } from "./sample.schemas.js";
import {
  OrderItemDownloadParamSchema,
  EpisodeDownloadBodySchema,
  EpisodeDownloadUrlSchema,
  ReleaseViewSchema,
} from "./download.schemas.js";
