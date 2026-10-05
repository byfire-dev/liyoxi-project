// 商家端：商城、选剧单与订购 · mall-config（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mMallConfigGet = merchantMeta({
  method: "get",
  path: "/m/mall-config",
  operationId: "m.mallConfig.get",
  summary: "商城配置：题材分类、筛选项、排序项、热门搜索词",
  "x-auth": "public",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
