// 后台：套餐积分与财务 · payment-exceptions（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  PaymentExceptionParamsSchema,
  PaymentExceptionListQuerySchema,
  PaymentExceptionPageSchema,
  PaymentExceptionDetailSchema,
  PaymentExceptionCreateBodySchema,
  PaymentExceptionResolveBodySchema,
  PaymentExceptionResolveResultSchema,
} from "./payment-exceptions.schemas.js";

export const adminPaymentExceptionList = adminRoute({
  request: { query: PaymentExceptionListQuerySchema },
  responses: { ...okResponse(PaymentExceptionPageSchema), ...errorResponses(400, 401, 403, 503) },
  method: "get",
  path: "/admin/payment-exceptions",
  operationId: "admin.paymentException.list",
  summary: "差异单列表（按日期、状态、类型）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentExceptionCreate = adminRoute({
  request: {
    body: {
      content: { "application/json": { schema: PaymentExceptionCreateBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(PaymentExceptionDetailSchema),
    ...errorResponses(400, 401, 403, 409, 503),
  },
  method: "post",
  path: "/admin/payment-exceptions",
  operationId: "admin.paymentException.create",
  summary: "登记异常到账（建孤儿收款与 bank_unmatched 差异单）",
  "x-permission": "finance.recon.resolve",
  "x-idempotent": "required",
});

export const adminPaymentExceptionGet = adminRoute({
  request: { params: PaymentExceptionParamsSchema },
  responses: { ...okResponse(PaymentExceptionDetailSchema), ...errorResponses(401, 403, 404, 503) },
  method: "get",
  path: "/admin/payment-exceptions/{paymentExceptionId}",
  operationId: "admin.paymentException.get",
  summary: "差异单详情：账单侧事实、平台侧事实、差异原因、可选处理方式",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentExceptionResolve = adminRoute({
  request: {
    params: PaymentExceptionParamsSchema,
    body: {
      content: { "application/json": { schema: PaymentExceptionResolveBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(PaymentExceptionResolveResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503, 504),
  },
  method: "post",
  path: "/admin/payment-exceptions/{paymentExceptionId}/resolve",
  operationId: "admin.paymentException.resolve",
  summary:
    "处理差异：补单、转退款（生成退款申请走审批）、重试履约、重建付款单、关联付款单并确认、线下退回、补记渠道退款、数据更正、核销（说明必填）",
  "x-permission": "finance.recon.resolve",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式（C51 先调外部、再开事务，A84）：restore、rebuild_order、record_channel_refund 先占用幂等记录、事务外查微信，再开事务落结果并写幂等记录；其余处理方式一个事务",
});
