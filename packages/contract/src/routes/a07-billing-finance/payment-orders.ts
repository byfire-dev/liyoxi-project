import {
  AdminPaymentOrderListQuerySchema,
  AdminPaymentOrderSummaryQuerySchema,
  AdminPaymentOrderPageSchema,
  AdminPaymentOrderSummarySchema,
} from "./channel-read.schemas.js";
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { PaymentOrderParamsSchema } from "../m07-billing/purchase.schemas.js";
import {
  AdminPaymentOrderCreateBodySchema,
  AdminTransferProofCreateBodySchema,
} from "./transfer-review.schemas.js";
import { TransferProofDetailSchema } from "./purchase.schemas.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";
// 后台：套餐积分与财务 · payment-orders（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPaymentOrderList = adminRoute({
  request: { query: AdminPaymentOrderListQuerySchema },
  responses: {
    ...okResponse(AdminPaymentOrderPageSchema),
    ...errorResponses(400, 401, 403, 404, 503),
  },
  method: "get",
  path: "/admin/payment-orders",
  operationId: "admin.paymentOrder.list",
  summary: "付款单列表：单号 / 商家 / 主体、时间、类型、支付方式、状态（5 种）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentOrderCreate = adminRoute({
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AdminPaymentOrderCreateBodySchema } },
    },
  },
  responses: {
    ...okResponse(PaymentOrderAdminDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/payment-orders",
  operationId: "admin.paymentOrder.create",
  summary: "线下开单（对公转账；须合同号，受控开关 controls.admin_create_order 开启）",
  "x-permission": "order.payment.create_offline",
  "x-idempotent": "required",
});

export const adminPaymentOrderSummary = adminRoute({
  request: { query: AdminPaymentOrderSummaryQuerySchema },
  responses: {
    ...okResponse(AdminPaymentOrderSummarySchema),
    ...errorResponses(400, 401, 403, 404, 503),
  },
  method: "get",
  path: "/admin/payment-orders/summary",
  operationId: "admin.paymentOrder.summary",
  summary: "付款单状态筛选条计数",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentOrderGet = adminRoute({
  responses: {
    ...okResponse(PaymentOrderAdminDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: { params: PaymentOrderParamsSchema },
  method: "get",
  path: "/admin/payment-orders/{paymentOrderId}",
  operationId: "admin.paymentOrder.get",
  summary: "付款单详情（右侧抽屉）：应付 / 实付、生效说明、计算式、支付记录、发票状态、操作日志",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentOrderRefundQuote = adminMeta({
  method: "post",
  path: "/admin/payment-orders/{paymentOrderId}/refund-quote",
  operationId: "admin.paymentOrder.refundQuote",
  summary: "现金退款试算（套餐 7 天窗口、资质终审不通过、规则外）",
  "x-permission": "order.refund.request",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminPaymentOrderRefundRequestCreate = adminMeta({
  method: "post",
  path: "/admin/payment-orders/{paymentOrderId}/refund-requests",
  operationId: "admin.paymentOrder.refundRequest.create",
  summary: "发起现金退款申请（服务端核算数额；同事务建审批单、暂停该周期与开票）",
  "x-permission": "order.refund.request",
  "x-idempotent": "required",
});

export const adminPaymentOrderTransferProofCreate = adminRoute({
  request: {
    params: PaymentOrderParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminTransferProofCreateBodySchema } },
    },
  },
  responses: {
    ...okResponse(TransferProofDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/payment-orders/{paymentOrderId}/transfer-proofs",
  operationId: "admin.paymentOrder.transferProof.create",
  summary: "后台代传对公转账凭证（触发识别与比对）",
  "x-permission": "finance.receipt.confirm",
  "x-idempotent": "required",
});
