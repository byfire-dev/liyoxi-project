// 商家端：商城、选剧单与订购 · home（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { HomeSchema, HomeQuerySchema } from "./mall.schemas.js";

export const mHomeGet = merchantRoute({
  method: "get",
  path: "/m/home",
  operationId: "m.home.get",
  summary:
    "首页聚合：城市、Banner、公告条、上线概览与清零提醒（老板）、为您推荐、推荐/新剧两栏各 4 部、选剧单数",
  "x-auth": "optional",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: HomeQuerySchema },
  responses: { ...okResponse(HomeSchema), ...errorResponses(400) },
});
