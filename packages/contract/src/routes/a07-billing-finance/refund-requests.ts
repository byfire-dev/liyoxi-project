// 后台：套餐积分与财务 · refund-requests（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  RefundParamsSchema,
  RefundListQuerySchema,
  RefundFilterSchema,
  RefundSummarySchema,
  RefundRequestPageSchema,
  RefundRequestDetailSchema,
  RefundApproveBodySchema,
  RefundExecuteBodySchema,
  RefundOfflineBodySchema,
  RefundRejectBodySchema,
  RefundWithdrawBodySchema,
  RefundVoidBodySchema,
  RefundRetryBodySchema,
  RefundNotAcceptedBodySchema,
} from "./refund.schemas.js";

export const adminRefundRequestList = adminRoute({
  request: { query: RefundListQuerySchema },
  responses: { ...okResponse(RefundRequestPageSchema), ...errorResponses(400, 401, 403, 503) },
  method: "get",
  path: "/admin/refund-requests",
  operationId: "admin.refundRequest.list",
  summary: "现金退款申请列表：页签（待审批、待执行（含执行中）、已处理、全部）、单号、商家",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminRefundRequestSummary = adminRoute({
  request: { query: RefundFilterSchema },
  responses: { ...okResponse(RefundSummarySchema), ...errorResponses(400, 401, 403, 503) },
  method: "get",
  path: "/admin/refund-requests/summary",
  operationId: "admin.refundRequest.summary",
  summary: "现金退款页签计数与指标：本月已退款金额与笔数、审批与执行中、本月驳回",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminRefundRequestGet = adminRoute({
  request: { params: RefundParamsSchema },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 503),
  },
  method: "get",
  path: "/admin/refund-requests/{refundRequestId}",
  operationId: "admin.refundRequest.get",
  summary:
    "现金退款申请详情：核算依据、执行结果与退款交易（失败原因、可否重试、可否确认未受理）、审批记录",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminRefundRequestApprove = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: { required: true, content: { "application/json": { schema: RefundApproveBodySchema } } },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/approve",
  operationId: "admin.refundRequest.approve",
  summary: "通过现金退款申请，进入待执行",
  "x-permission": "finance.refund.approve",
  "x-idempotent": "required",
});

export const adminRefundRequestConfirmNotAccepted = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: RefundNotAcceptedBodySchema } },
    },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503, 504),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/confirm-not-accepted",
  operationId: "admin.refundRequest.confirmNotAccepted",
  summary: "确认微信未受理（停止重试 ≥10 分钟且查询无此退款单），申请回到待执行",
  "x-permission": "finance.refund.execute",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式（C51 先调外部、再开事务，A84）：占用后事务外按 out_refund_no 查询微信，再开事务落结果并写幂等记录",
});

export const adminRefundRequestExecute = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: { required: true, content: { "application/json": { schema: RefundExecuteBodySchema } } },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/execute",
  operationId: "admin.refundRequest.execute",
  summary:
    "执行退款（微信原路）：勾选核对原交易单号与金额；先回收权益再提交微信退款，结果由回调或查单落终态",
  "x-permission": "finance.refund.execute",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式，多事务形态（C51）：事务 E1 落意图、回收权益、建 refund_txn(created) 并提交 → 事务外以 out_refund_no 调微信 → 事务 E2 落外调结果并写幂等记录；C51 已登记为“多事务”（A154）",
});

export const adminRefundRequestRecordOffline = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: { required: true, content: { "application/json": { schema: RefundOfflineBodySchema } } },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/record-offline",
  operationId: "admin.refundRequest.recordOffline",
  summary: "线下退款登记（对公付款的退款）：转账日期、银行流水号、回单文件",
  "x-permission": "finance.refund.execute",
  "x-idempotent": "required",
});

export const adminRefundRequestReject = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: { required: true, content: { "application/json": { schema: RefundRejectBodySchema } } },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/reject",
  operationId: "admin.refundRequest.reject",
  summary: "驳回现金退款申请（说明必填），恢复周期与开票",
  "x-permission": "finance.refund.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminRefundRequestRetry = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: { required: true, content: { "application/json": { schema: RefundRetryBodySchema } } },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/retry",
  operationId: "admin.refundRequest.retry",
  summary: "以同一商户退款单号重试微信退款",
  "x-permission": "finance.refund.execute",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式（C51 先调外部、再开事务，A50）：占用后事务外以原 out_refund_no 提交微信，再开事务落结果并写幂等记录",
});

export const adminRefundRequestVoid = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: { required: true, content: { "application/json": { schema: RefundVoidBodySchema } } },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/void",
  operationId: "admin.refundRequest.void",
  summary: "作废已审批未执行的退款申请（说明必填），恢复周期与开票",
  "x-permission": "finance.refund.approve",
  "x-idempotent": "required",
});

export const adminRefundRequestWithdraw = adminRoute({
  request: {
    params: RefundParamsSchema,
    body: { required: true, content: { "application/json": { schema: RefundWithdrawBodySchema } } },
  },
  responses: {
    ...okResponse(RefundRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/refund-requests/{refundRequestId}/withdraw",
  operationId: "admin.refundRequest.withdraw",
  summary: "撤回尚未审批的现金退款申请（仅申请人；发起人已停用时代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
