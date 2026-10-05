// 商家端：套餐、积分、付款与发票 · invoice-requests（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mInvoiceRequestList = merchantMeta({
  method: "get",
  path: "/m/invoice-requests",
  operationId: "m.invoiceRequest.list",
  summary:
    "开票记录：类型、介质、项目、状态（开票中/已开具/已驳回/红冲中/已红冲）、金额、申请单号、付款单号、申请与开具时间、发票号码、进度说明",
  "x-capability": "invoice.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mInvoiceRequestCreate = merchantMeta({
  method: "post",
  path: "/m/invoice-requests",
  operationId: "m.invoiceRequest.create",
  summary:
    "按付款单申请开票：{paymentOrderId, invoiceType, medium, 专票地址电话与开户行账号, 接收邮箱, 邮寄信息（收件电话用 phoneSource）}；抬头与税号取认证主体，不接收",
  "x-capability": "invoice.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mInvoiceRequestSummary = merchantMeta({
  method: "get",
  path: "/m/invoice-requests/summary",
  operationId: "m.invoiceRequest.summary",
  summary: "开票页“开票记录 · N”计数、各状态计数，以及开票页上下文（抬头卡、申请弹层默认值）",
  "x-capability": "invoice.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mInvoiceRequestDownloadUrls = merchantMeta({
  method: "post",
  path: "/m/invoice-requests/{invoiceRequestId}/download-urls",
  operationId: "m.invoiceRequest.downloadUrls",
  summary: "签发发票文件的 5 分钟读地址（请求体指明哪一张：蓝字或红字），每次写访问审计",
  "x-capability": "invoice.*",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录，避免回放过期地址（A18、A19）",
});
