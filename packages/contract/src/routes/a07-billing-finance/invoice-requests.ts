import {
  AdminInvoiceFilterSchema,
  AdminInvoiceListQuerySchema,
  AdminInvoiceSummarySchema,
  InvoiceIssueBodySchema,
  InvoiceIssueRedBodySchema,
  InvoiceRejectBodySchema,
  InvoiceRequestAdminDetailSchema,
  InvoiceRequestAdminPageSchema,
} from "./invoices.schemas.js";
import { InvoiceRequestParamsSchema } from "../m07-billing/invoices.schemas.js";
// 后台：套餐积分与财务 · invoice-requests（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";

export const adminInvoiceRequestList = adminRoute({
  responses: {
    ...okResponse(InvoiceRequestAdminPageSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: { query: AdminInvoiceListQuerySchema },
  method: "get",
  path: "/admin/invoice-requests",
  operationId: "admin.invoiceRequest.list",
  summary: "开票申请队列：待开票、待红冲、已处理（已开具、已寄出、已驳回、已红冲）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminInvoiceRequestSummary = adminRoute({
  responses: {
    ...okResponse(AdminInvoiceSummarySchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: { query: AdminInvoiceFilterSchema },
  method: "get",
  path: "/admin/invoice-requests/summary",
  operationId: "admin.invoiceRequest.summary",
  summary: "发票页 KPI：待开票金额与张数、本月已开票",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminInvoiceRequestGet = adminRoute({
  responses: {
    ...okResponse(InvoiceRequestAdminDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: { params: InvoiceRequestParamsSchema },
  method: "get",
  path: "/admin/invoice-requests/{invoiceRequestId}",
  operationId: "admin.invoiceRequest.get",
  summary: "开票申请详情：付款单、抬头与税号（脱敏）、专票信息、接收方式、开票前自动核对项",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminInvoiceRequestIssue = adminRoute({
  responses: {
    ...okResponse(InvoiceRequestAdminDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: {
    params: InvoiceRequestParamsSchema,
    body: { required: true, content: { "application/json": { schema: InvoiceIssueBodySchema } } },
  },
  method: "post",
  path: "/admin/invoice-requests/{invoiceRequestId}/issue",
  operationId: "admin.invoiceRequest.issue",
  summary:
    "开具：电子（发票号码 20 位 + PDF / OFD 文件，推送商家并发邮件）或纸质（号码 + 快递公司 + 运单号）",
  "x-permission": "finance.invoice.issue",
  "x-idempotent": "required",
});

export const adminInvoiceRequestIssueRed = adminRoute({
  responses: {
    ...okResponse(InvoiceRequestAdminDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: {
    params: InvoiceRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: InvoiceIssueRedBodySchema } },
    },
  },
  method: "post",
  path: "/admin/invoice-requests/{invoiceRequestId}/issue-red",
  operationId: "admin.invoiceRequest.issueRed",
  summary: "回填红字发票（号码 + 文件），之后才能执行该付款单的退款",
  "x-permission": "finance.invoice.red",
  "x-idempotent": "required",
});

export const adminInvoiceRequestReject = adminRoute({
  responses: {
    ...okResponse(InvoiceRequestAdminDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: {
    params: InvoiceRequestParamsSchema,
    body: { required: true, content: { "application/json": { schema: InvoiceRejectBodySchema } } },
  },
  method: "post",
  path: "/admin/invoice-requests/{invoiceRequestId}/reject",
  operationId: "admin.invoiceRequest.reject",
  summary: "驳回开票申请（原因 + 说明；商家可补正后重新申请）",
  "x-permission": "finance.invoice.issue",
  "x-idempotent": "required",
});

export const adminInvoiceRequestResend = adminRoute({
  responses: {
    ...okResponse(InvoiceRequestAdminDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  request: { params: InvoiceRequestParamsSchema },
  method: "post",
  path: "/admin/invoice-requests/{invoiceRequestId}/resend",
  operationId: "admin.invoiceRequest.resend",
  summary: "重发电子发票邮件",
  "x-permission": "finance.invoice.issue",
  "x-idempotent": "required",
});
