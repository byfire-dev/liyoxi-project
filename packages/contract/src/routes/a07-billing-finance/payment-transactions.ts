// 后台：套餐积分与财务 · payment-transactions（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPaymentTransactionList = adminMeta({
  method: "get",
  path: "/admin/payment-transactions",
  operationId: "admin.paymentTransaction.list",
  summary:
    "收款流水：付款单号 / 交易单号 / 商家搜索，时间、类型、方式、对账状态（合计由 summary 按同一筛选给出）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPaymentTransactionSummary = adminMeta({
  method: "get",
  path: "/admin/payment-transactions/summary",
  operationId: "admin.paymentTransaction.summary",
  summary: "收款流水 KPI：今日收款、本月收款、本月退款、对账差异",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
