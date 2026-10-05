// 商家端：商城、选剧单与订购 · favorites（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mFavoriteCreate = merchantMeta({
  method: "post",
  path: "/m/favorites",
  operationId: "m.favorite.create",
  summary: "V1.1：收藏短剧 {dramaId}",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});

export const mFavoriteDelete = merchantMeta({
  method: "delete",
  path: "/m/favorites/{favoriteId}",
  operationId: "m.favorite.delete",
  summary: "V1.1：取消收藏",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});
