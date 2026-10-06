// 商家端：商城、选剧单与订购 · cart-items（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantRoute } from "../builders.js";
import { z } from "../../zod.js";
import { IdSchema, okResponse, errorResponses } from "../../common/index.js";
import {
  CartItemSchema,
  CartListSchema,
  CartCreateBodySchema,
  CartAcceptBodySchema,
  CartAcceptResultSchema,
} from "./read.schemas.js";

export const mCartItemList = merchantRoute({
  responses: { ...okResponse(CartListSchema), ...errorResponses(400, 401, 403) },
  method: "get",
  path: "/m/cart-items",
  operationId: "m.cartItem.list",
  summary:
    "选剧单（当前门店）：每项 valid / price_changed / invalid、加入时价格快照与当前价、折后实扣、可使用至；合计与可用积分",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mCartItemCreate = merchantRoute({
  request: {
    body: { required: true, content: { "application/json": { schema: CartCreateBodySchema } } },
  },
  responses: { ...okResponse(CartItemSchema), ...errorResponses(400, 401, 403, 404, 409) },
  method: "post",
  path: "/m/cart-items",
  operationId: "m.cartItem.create",
  summary: "加入选剧单 {dramaId}（同店同剧唯一，上限 50 部）",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_cart_item_store_id_drama_id"],
});

export const mCartItemDelete = merchantRoute({
  request: { params: z.object({ cartItemId: IdSchema }) },
  responses: { ...okResponse(z.null()), ...errorResponses(400, 401, 403, 404, 409) },
  method: "delete",
  path: "/m/cart-items/{cartItemId}",
  operationId: "m.cartItem.delete",
  summary: "移出选剧单",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mCartItemAcceptPrice = merchantRoute({
  request: {
    params: z.object({ cartItemId: IdSchema }),
    body: { required: true, content: { "application/json": { schema: CartAcceptBodySchema } } },
  },
  responses: { ...okResponse(CartAcceptResultSchema), ...errorResponses(400, 401, 403, 404, 409) },
  "x-redact-on-replay": ["drama.posterUrl"],
  method: "post",
  path: "/m/cart-items/{cartItemId}/accept-price",
  operationId: "m.cartItem.acceptPrice",
  summary:
    "确认新价格 {acceptedPricePoints}（与当前价比对，不符返回 CART_PRICE_CHANGED；把价格快照更新为当前价，恢复可勾选）",
  "x-capability": "cart.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
