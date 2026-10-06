// 商家端：客服、消息与通用接口 · dict-items（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { errorResponses, okResponse } from "../../common/index.js";
import { merchantRoute } from "../builders.js";
import { DictItemListQuerySchema, DictItemListResultSchema } from "./dict-items.schemas.js";

export const mDictItemList = merchantRoute({
  method: "get",
  path: "/m/dict-items",
  operationId: "m.dictItem.list",
  summary:
    "数据字典（?typeKey=industry,region,genre,selling_tag,store_selling_point,permit_type,custom_focus,asset_tag,ad_promo_point,ticket_type,ticket_withdraw_reason,plan_tier,point_type&parentCode=&includeDisabled=）；响应 { items: DictTypeItems[] }（有界小集合，C42、A78）",
  "x-auth": "public",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: DictItemListQuerySchema },
  responses: { ...okResponse(DictItemListResultSchema), ...errorResponses(400) },
});
