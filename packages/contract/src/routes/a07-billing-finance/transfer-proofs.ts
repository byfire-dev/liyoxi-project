// 后台：套餐积分与财务 · transfer-proofs（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminTransferProofList = adminMeta({
  method: "get",
  path: "/admin/transfer-proofs",
  operationId: "admin.transferProof.list",
  summary: "对公收款确认队列：待确认、今日已处理；提示标签（昨日上传、附言缺付款单号）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTransferProofSummary = adminMeta({
  method: "get",
  path: "/admin/transfer-proofs/summary",
  operationId: "admin.transferProof.summary",
  summary: "对公收款确认页签计数：待确认、今日已处理",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTransferProofGet = adminMeta({
  method: "get",
  path: "/admin/transfer-proofs/{transferProofId}",
  operationId: "admin.transferProof.get",
  summary: "凭证详情：付款单信息、业务提示、凭证图、识别字段与系统比对（户名、金额、附言、时间）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTransferProofApproveReview = adminMeta({
  method: "post",
  path: "/admin/transfer-proofs/{transferProofId}/approve-review",
  operationId: "admin.transferProof.approveReview",
  summary: "对公大额二人复核通过：凭证置已接受、付款单已支付并入账履约",
  "x-permission": "finance.receipt.confirm",
  "x-idempotent": "required",
});

export const adminTransferProofConfirm = adminMeta({
  method: "post",
  path: "/admin/transfer-proofs/{transferProofId}/confirm",
  operationId: "admin.transferProof.confirm",
  summary: "确认到账：勾选已查到银行流水 + 银行流水号（规范化后唯一）+ 回显单号与金额；入账并履约",
  "x-permission": "finance.receipt.confirm",
  "x-idempotent": "required",
});

export const adminTransferProofReject = adminMeta({
  method: "post",
  path: "/admin/transfer-proofs/{transferProofId}/reject",
  operationId: "admin.transferProof.reject",
  summary: "驳回凭证（原因 + 说明）：付款单回到待支付（凭证被驳回），对公有效期顺延，商家可重传",
  "x-permission": "finance.receipt.reject",
  "x-idempotent": "required",
});

export const adminTransferProofRejectReview = adminMeta({
  method: "post",
  path: "/admin/transfer-proofs/{transferProofId}/reject-review",
  operationId: "admin.transferProof.rejectReview",
  summary: "对公大额二人复核退回（说明必填）：清空第一确认内容，付款单回到待财务确认",
  "x-permission": "finance.receipt.confirm",
  "x-step-up": "skip",
  "x-idempotent": "required",
});
