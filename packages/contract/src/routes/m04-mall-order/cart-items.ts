// 商家端：商城、选剧单与订购 · cart-items（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mCartItemList = merchantMeta({
  method: "get",
  path: "/m/cart-items",
  operationId: "m.cartItem.list",
  summary:
    "选剧单（当前门店）：每项 valid / price_changed / invalid、加入时价格快照与当前价、折后实扣、可使用至；合计与可用积分",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mCartItemCreate = merchantMeta({
  method: "post",
  path: "/m/cart-items",
  operationId: "m.cartItem.create",
  summary: "加入选剧单 {dramaId}（同店同剧唯一，上限 50 部）",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_cart_item_store_id_drama_id"],
});

export const mCartItemDelete = merchantMeta({
  method: "delete",
  path: "/m/cart-items/{cartItemId}",
  operationId: "m.cartItem.delete",
  summary: "移出选剧单",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mCartItemAcceptPrice = merchantMeta({
  method: "post",
  path: "/m/cart-items/{cartItemId}/accept-price",
  operationId: "m.cartItem.acceptPrice",
  summary:
    "确认新价格 {acceptedPricePoints}（与当前价比对，不符返回 CART_PRICE_CHANGED；把价格快照更新为当前价，恢复可勾选）",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
