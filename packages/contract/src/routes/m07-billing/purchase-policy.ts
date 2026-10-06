import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { PurchasePolicySchema } from "./purchase.schemas.js";
// 商家端：套餐、积分、付款与发票 · purchase-policy（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。

export const mPurchasePolicyGet = merchantRoute({
  responses: {
    ...okResponse(PurchasePolicySchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "get",
  path: "/m/purchase-policy",
  operationId: "m.purchasePolicy.get",
  summary:
    "购买策略（mode、isPriceShown、isPurchasePromptAllowed、channels[]、copy），给没有金额上下文的入口用（如钱包页的续费与加购入口、积分不足引导）",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
