// 商家端：商城、选剧单与订购 · order-items（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mOrderItemList = merchantMeta({
  method: "get",
  path: "/m/order-items",
  operationId: "m.orderItem.list",
  summary:
    "我的短剧（以订单项为行，?tab=all|live|to_launch|ended）：剧名、剩余天数、发布账号、使用期、订单号、各剧制作阶段与约定上线日",
  "x-capability": "order.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mOrderItemSummary = merchantMeta({
  method: "get",
  path: "/m/order-items/summary",
  operationId: "m.orderItem.summary",
  summary:
    "我的短剧的页签计数：上线中 · N 部、待上线 · N 部等，键与列表 tab 取值一致；另带副指标 delivering（制作中 + 待上线，供“我的”页与门店卡）",
  "x-capability": "order.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mOrderItemGet = merchantMeta({
  method: "get",
  path: "/m/order-items/{orderItemId}",
  operationId: "m.orderItem.get",
  summary:
    "订单项详情：剧目、整部集数、上线状态与已上线集数、使用期起止与剩余天数、发布账号、订单号",
  "x-capability": "order.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
