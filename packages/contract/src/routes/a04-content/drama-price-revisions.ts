// 后台：短剧库与积分价 · drama-price-revisions（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { IdSchema, errorResponses, okResponse } from "../../common/index.js";
import {
  DramaPriceNoteBodySchema,
  DramaPriceRevisionListQuerySchema,
  DramaPriceRevisionPageSchema,
  DramaPriceRevisionSchema,
} from "./drama-pricing.schemas.js";

export const adminDramaPriceRevisionList = adminRoute({
  method: "get",
  path: "/admin/drama-price-revisions",
  operationId: "admin.dramaPriceRevision.list",
  summary: "调价记录（含待生效、已撤销）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: DramaPriceRevisionListQuerySchema },
  responses: { ...okResponse(DramaPriceRevisionPageSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminDramaPriceRevisionWithdraw = adminRoute({
  method: "post",
  path: "/admin/drama-price-revisions/{dramaPriceRevisionId}/withdraw",
  operationId: "admin.dramaPriceRevision.withdraw",
  summary: "撤销尚未生效的调价",
  "x-permission": "billing.price.edit",
  "x-idempotent": "required",
  request: {
    params: z.object({ dramaPriceRevisionId: IdSchema }),
    body: { content: { "application/json": { schema: DramaPriceNoteBodySchema } } },
  },
  responses: {
    ...okResponse(DramaPriceRevisionSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});
