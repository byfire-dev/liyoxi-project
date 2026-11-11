// 后台：发布与巡检 · delivery-releases（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { z } from "../../zod.js";

export const adminDeliveryReleaseGet = adminRoute({
  method: "get",
  path: "/admin/delivery-releases/{deliveryReleaseId}",
  operationId: "admin.deliveryRelease.get",
  summary: "成片包详情（清单、大小、ZIP 缓存状态）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: DeliveryReleaseParamSchema },
  responses: {
    ...okResponse(DeliveryReleaseDetailSchema),
    ...errorResponses(400, 401, 403, 404, 500),
  },
});
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  DeliveryReleaseParamSchema,
  DeliveryReleaseDetailSchema,
  DeliveryReleasePackResultSchema,
} from "./delivery-release.schemas.js";

export const adminDeliveryReleasePack = adminRoute({
  method: "post",
  path: "/admin/delivery-releases/{deliveryReleaseId}/pack",
  operationId: "admin.deliveryRelease.pack",
  summary: "预打包 ZIP（供电脑端下载页整包下载）",
  "x-permission": "publish.package.push",
  "x-idempotent": "required",
  request: {
    params: DeliveryReleaseParamSchema,
    body: { required: true, content: { "application/json": { schema: z.strictObject({}) } } },
  },
  responses: {
    ...okResponse(DeliveryReleasePackResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});
