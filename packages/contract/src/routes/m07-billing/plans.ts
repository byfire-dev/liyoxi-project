import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { PlanListSchema, PlanQuoteBodySchema, PlanQuoteSchema } from "./purchase.schemas.js";
// 商家端：套餐、积分、付款与发票 · plans（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。

export const mPlanList = merchantRoute({
  responses: { ...okResponse(PlanListSchema), ...errorResponses(400, 401, 403, 404, 409, 503) },
  method: "get",
  path: "/m/plans",
  operationId: "m.plan.list",
  summary:
    "上架中的套餐版本与权益（月费、每月积分、折扣、制作模型、门店与成员上限、排期）；是否返回价格与购买入口由购买策略决定",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mPlanQuote = merchantRoute({
  responses: { ...okResponse(PlanQuoteSchema), ...errorResponses(400, 401, 403, 404, 409, 503) },
  request: {
    body: { required: true, content: { "application/json": { schema: PlanQuoteBodySchema } } },
  },
  method: "post",
  path: "/m/plans/quote",
  operationId: "m.plan.quote",
  summary:
    "套餐报价（不落库）：{planId, months}→ 动作类型（开通/续费/升级/降级/下期换版本）、应付、新周期、积分发放与补发、补差价、降级须移除的门店与成员数；附购买策略",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算，不写库、不缓存、不拿账户锁、不 advance（A18、A20、C13）",
});
