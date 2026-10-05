// 后台：套餐积分与财务 · payment-exceptions（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPaymentExceptionList = adminMeta({
  method: "get",
  path: "/admin/payment-exceptions",
  operationId: "admin.paymentException.list",
  summary: "差异单列表（按日期、状态、类型）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentExceptionCreate = adminMeta({
  method: "post",
  path: "/admin/payment-exceptions",
  operationId: "admin.paymentException.create",
  summary: "登记异常到账（建孤儿收款与 bank_unmatched 差异单）",
  "x-permission": "finance.recon.resolve",
  "x-idempotent": "required",
});

export const adminPaymentExceptionGet = adminMeta({
  method: "get",
  path: "/admin/payment-exceptions/{paymentExceptionId}",
  operationId: "admin.paymentException.get",
  summary: "差异单详情：账单侧事实、平台侧事实、差异原因、可选处理方式",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentExceptionResolve = adminMeta({
  method: "post",
  path: "/admin/payment-exceptions/{paymentExceptionId}/resolve",
  operationId: "admin.paymentException.resolve",
  summary:
    "处理差异：补单、转退款（生成退款申请走审批）、重试履约、重建付款单、关联付款单并确认、线下退回、补记渠道退款、数据更正、核销（说明必填）",
  "x-permission": "finance.recon.resolve",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式（C51 先调外部、再开事务，A84）：restore、record_channel_refund 先占用幂等记录、事务外查微信，再开事务落结果并写幂等记录；其余处理方式一个事务",
});
