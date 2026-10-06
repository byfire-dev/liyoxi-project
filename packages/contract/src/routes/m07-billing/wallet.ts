import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { BillingWalletSchema } from "./purchase.schemas.js";
// 商家端：套餐、积分、付款与发票 · wallet（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。

export const mWalletGet = merchantRoute({
  responses: {
    ...okResponse(BillingWalletSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "get",
  path: "/m/wallet",
  operationId: "m.wallet.get",
  summary:
    "套餐与积分：当前套餐（版本、状态、有效期、剩余天数、周期、权益）、门店与成员名额（同 m02 2.1）、两类积分余额、冻结数、即将清零数量与时刻、过期态（已清零数量、加购积分停用）、是否退款处理中（主体级）、加购拦截态、积分规则参数",
  "x-capability": "wallet.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
