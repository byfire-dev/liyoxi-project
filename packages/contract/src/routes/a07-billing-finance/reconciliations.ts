// 后台：套餐积分与财务 · reconciliations（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminReconciliationList = adminMeta({
  method: "get",
  path: "/admin/reconciliations",
  operationId: "admin.reconciliation.list",
  summary:
    "按月查看对账：月度概览、每日对账行（平台收款、微信账单、对公、退款、差异、状态）、账单下载进度",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReconciliationRerun = adminMeta({
  method: "post",
  path: "/admin/reconciliations/{reconciliationId}/rerun",
  operationId: "admin.reconciliation.rerun",
  summary: "重新对账（重跑某日匹配步骤）",
  "x-permission": "finance.recon.resolve",
  "x-idempotent": "required",
});
