// 套餐与积分模块的路由清单。
import { pricingRoute } from "../billing/pricing";
import { plansRoute } from "../billing/plans";
import { pointpacksRoute } from "../billing/point-packs";
import { paramsRoute } from "../billing/params";
import { accountsRoute } from "../billing/accounts";
export const billingRoutes = [
  pricingRoute,
  plansRoute,
  pointpacksRoute,
  paramsRoute,
  accountsRoute,
] as const;
