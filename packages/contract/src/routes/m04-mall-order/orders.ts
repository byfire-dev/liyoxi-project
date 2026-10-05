// 商家端：商城、选剧单与订购 · orders（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mOrderList = merchantMeta({
  method: "get",
  path: "/m/orders",
  operationId: "m.order.list",
  summary:
    "我的订单（?tab=all|producing|to_launch|live|ended|after_sale；?no= 按单号查找）：订单号、时间、状态、剧目概要、积分、置顶待办；售后页签含取消与积分退回",
  "x-capability": "order.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mOrderCreate = merchantMeta({
  method: "post",
  path: "/m/orders",
  operationId: "m.order.create",
  summary:
    "确认订购：{dramaIds, channelAccountIds, focusCodes, referenceStoreAssetIds?, note?, isTopModel?, adIds?, expectedLaunchDate?, agreementVersionId, expect}；逐部冻结积分，建订购单与订单项，记协议同意",
  "x-capability": "order.create",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mOrderQuote = merchantMeta({
  method: "post",
  path: "/m/orders/quote",
  operationId: "m.order.quote",
  summary:
    "订购报价（纯计算不落库）：逐部积分价、折扣、顶级模型加扣、实扣、合计、扣减来源（各批次套餐积分 / 加购积分）、订购后剩余、可选账号、可用广告、最早可指定上线日、主体与门店联系人",
  "x-capability": "order.create",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算，不写库、不缓存（A18、A20）",
});

export const mOrderGet = merchantMeta({
  method: "get",
  path: "/m/orders/{orderId}",
  operationId: "m.order.get",
  summary:
    "订单详情：状态与待办、交付时间轴、剧目明细（含已上线集数与使用期）、方案摘要与 deliveryPlanId、积分明细（冻结、扣减、三个实际退回数量）、订单信息、协议与授权书列表",
  "x-capability": "order.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
