// 后台：订购、取消、交付与广告任务 · reissues（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  ReissueParamSchema,
  ReissueCancelBodySchema,
  ReissuePublishBodySchema,
  ReissueViewSchema,
  ReissueWriteResultSchema,
} from "./delivery.schemas.js";
import { ReleaseAdminViewSchema } from "./production.schemas.js";

export const ReissuePublishResultSchema = z
  .strictObject({
    reissue: ReissueViewSchema,
    release: ReleaseAdminViewSchema,
    replayed: z.boolean(),
  })
  .openapi("ReissuePublishResult");
export type ReissuePublishResult = z.infer<typeof ReissuePublishResultSchema>;

export const adminReissueCancel = adminRoute({
  method: "post",
  path: "/admin/reissues/{reissueId}/cancel",
  operationId: "admin.reissue.cancel",
  summary: "取消补发",
  "x-permission": "delivery.package.reissue",
  "x-idempotent": "required",
  request: {
    params: ReissueParamSchema,
    body: { required: true, content: { "application/json": { schema: ReissueCancelBodySchema } } },
  },
  responses: {
    ...okResponse(ReissueWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminReissuePublish = adminRoute({
  method: "post",
  path: "/admin/reissues/{reissueId}/publish",
  operationId: "admin.reissue.publish",
  summary: "发布补发：替换行生效，旧成片包被新包取代并重发下载授权",
  "x-permission": "publish.package.push",
  "x-idempotent": "required",
  request: {
    params: ReissueParamSchema,
    body: { required: true, content: { "application/json": { schema: ReissuePublishBodySchema } } },
  },
  responses: {
    ...okResponse(ReissuePublishResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});
