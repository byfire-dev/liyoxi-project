// 后台：短剧库与积分价 · drama-prices（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  DramaPriceListQuerySchema,
  DramaPricePageSchema,
  DramaPriceSummaryQuerySchema,
  DramaPriceSummarySchema,
} from "./drama-pricing.schemas.js";

export const adminDramaPriceList = adminRoute({
  method: "get",
  path: "/admin/drama-prices",
  operationId: "admin.dramaPrice.list",
  summary: "单剧积分价列表：等级、模板价、积分价、三个版本实扣、授权期、生效时间",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: DramaPriceListQuerySchema },
  responses: { ...okResponse(DramaPricePageSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminDramaPriceSummary = adminRoute({
  method: "get",
  path: "/admin/drama-prices/summary",
  operationId: "admin.dramaPrice.summary",
  summary: "单剧积分价页首计数：已上架、单剧调整、本月订购；页头上下文带最短可订月数",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: DramaPriceSummaryQuerySchema },
  responses: { ...okResponse(DramaPriceSummarySchema), ...errorResponses(400, 401, 403, 429) },
});
