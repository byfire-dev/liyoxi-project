// 后台：短剧库与积分价 · price-tier-revisions（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import { PriceTierListSchema } from "./drama-pricing.schemas.js";

export const adminPriceTierRevisionList = adminRoute({
  method: "get",
  path: "/admin/price-tier-revisions",
  operationId: "admin.priceTierRevision.list",
  summary: "S / A / B / C 等级模板价：当前值、适用剧目数、按模板定价剧目数",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  responses: { ...okResponse(PriceTierListSchema), ...errorResponses(400, 401, 403, 429) },
});
