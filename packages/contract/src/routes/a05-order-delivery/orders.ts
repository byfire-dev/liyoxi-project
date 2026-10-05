// 后台：订购、取消、交付与广告任务 · orders（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminOrderList = adminMeta({
  method: "get",
  path: "/admin/orders",
  operationId: "admin.order.list",
  summary: "订购单列表：订单号 / 商家 / 剧名、下单时间、交付经理、剧目、状态（8 种）；每页 10",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminOrderQuote = adminMeta({
  method: "post",
  path: "/admin/orders/quote",
  operationId: "admin.order.quote",
  summary:
    "订购积分试算：剧目、套餐版本、是否顶级模型 → P、R、T、S 与算式（与商家端确认订购同一实现）",
  "x-permission": null,
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminOrderSummary = adminMeta({
  method: "get",
  path: "/admin/orders/summary",
  operationId: "admin.order.summary",
  summary: "订购单状态筛选条计数",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminOrderGet = adminMeta({
  method: "get",
  path: "/admin/orders/{orderId}",
  operationId: "admin.order.get",
  summary:
    "订购单详情：进度、剧目明细与工单、定制需求、协议与授权书、积分明细与冻结扣减时间线、商家与负责人",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminOrderActivityList = adminMeta({
  method: "get",
  path: "/admin/orders/{orderId}/activities",
  operationId: "admin.order.activity.list",
  summary: "订购单操作日志",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminOrderCancelQuote = adminMeta({
  method: "post",
  path: "/admin/orders/{orderId}/cancel-quote",
  operationId: "admin.order.cancelQuote",
  summary: "取消预览：按剧逐行核算（阶段、已扣、扣除比例、退回）与账本去向；切换原因即重算",
  "x-permission": "order.refund.request",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminOrderCancelRequestCreate = adminMeta({
  method: "post",
  path: "/admin/orders/{orderId}/cancel-requests",
  operationId: "admin.order.cancelRequest.create",
  summary:
    "发起订购取消（原因、说明 ≥5 字）：同事务建取消申请与审批单，订单进入售后处理中、工单暂停",
  "x-permission": "order.refund.request",
  "x-idempotent": "required",
});
