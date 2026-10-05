// 商家端：商城、选剧单与订购 · dramas（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mDramaList = merchantMeta({
  method: "get",
  path: "/m/dramas",
  operationId: "m.drama.list",
  summary:
    "商城列表：?q=（关键词）、genreCodes（题材）、industryCodes（适配行业）、集数、积分价区间、排序、分页（20/页）；老板另返回按当前套餐算的实扣积分",
  "x-auth": "optional",
  "x-capability": "catalog.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mDramaSearch = merchantMeta({
  method: "get",
  path: "/m/dramas/search",
  operationId: "m.drama.search",
  summary:
    "搜索（?q=）：按剧名、题材、主演匹配，剧名命中在前；未命中且关键词属于某品类时按适配行业兜底，返回 mode: match | industry_fallback",
  "x-auth": "optional",
  "x-capability": "catalog.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mDramaGet = merchantMeta({
  method: "get",
  path: "/m/dramas/{dramaId}",
  operationId: "m.drama.get",
  summary:
    "短剧详情：基础信息、积分价与实扣、当前可用积分与即将清零（老板）、简介与角色、适配推荐、定制与植入说明、许可与可使用至、订购须知",
  "x-auth": "optional",
  "x-capability": "catalog.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mDramaTrialEpisodeList = merchantMeta({
  method: "get",
  path: "/m/dramas/{dramaId}/trial-episodes",
  operationId: "m.drama.trialEpisode.list",
  summary: "V1.1：选集试看（前 N 集免费试看）",
  "x-auth": "optional",
  "x-capability": "catalog.read",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
