import {
  DramaPermitRetireBodySchema,
  DramaPermitUpdateBodySchema,
  DramaPermitWriteResultSchema,
} from "./drama-lifecycle.schemas.js";
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { IdSchema, errorResponses, okResponse } from "../../common/index.js";
// 后台：短剧库与积分价 · drama-permits（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。

export const adminDramaPermitUpdate = adminRoute({
  method: "patch",
  path: "/admin/drama-permits/{dramaPermitId}",
  operationId: "admin.dramaPermit.update",
  summary: "修改许可行",
  "x-permission": null,
  "x-idempotent": "required",
  request: {
    params: z.object({ dramaPermitId: IdSchema }),
    body: { content: { "application/json": { schema: DramaPermitUpdateBodySchema } } },
  },
  responses: {
    ...okResponse(DramaPermitWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});

export const adminDramaPermitRetire = adminRoute({
  method: "post",
  path: "/admin/drama-permits/{dramaPermitId}/retire",
  operationId: "admin.dramaPermit.retire",
  summary: "停用许可行",
  "x-permission": null,
  "x-idempotent": "required",
  request: {
    params: z.object({ dramaPermitId: IdSchema }),
    body: { content: { "application/json": { schema: DramaPermitRetireBodySchema } } },
  },
  responses: {
    ...okResponse(DramaPermitWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});
