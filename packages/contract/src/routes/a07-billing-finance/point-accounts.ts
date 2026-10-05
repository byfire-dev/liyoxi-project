// 后台：套餐积分与财务 · point-accounts（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPointAccountList = adminMeta({
  method: "get",
  path: "/admin/point-accounts",
  operationId: "admin.pointAccount.list",
  summary:
    "积分账户列表（主体）：套餐、套餐积分与清零时间、加购积分、可用与冻结；筛选套餐与账户状态",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAccountSummary = adminMeta({
  method: "get",
  path: "/admin/point-accounts/summary",
  operationId: "admin.pointAccount.summary",
  summary: "积分账户页 KPI：积分余额（含冻结）、本月发放、本月消耗",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAccountGet = adminMeta({
  method: "get",
  path: "/admin/point-accounts/{pointAccountId}",
  operationId: "admin.pointAccount.get",
  summary: "积分账户详情：套餐、本期、可用 / 套餐 / 加购 / 冻结、在办退款与待审调整提示",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAccountAdjustmentQuote = adminMeta({
  method: "post",
  path: "/admin/point-accounts/{pointAccountId}/adjustment-quote",
  operationId: "admin.pointAccount.adjustmentQuote",
  summary: "积分调整影响预览：方向、类型、数量 → 可用 a → b",
  "x-permission": "billing.adjust.request",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminPointAccountPointLedgerEntryList = adminMeta({
  method: "get",
  path: "/admin/point-accounts/{pointAccountId}/point-ledger-entries",
  operationId: "admin.pointAccount.pointLedgerEntry.list",
  summary: "积分流水：分组（获得、使用、清零），时间倒序游标分页，每行带变动后可用余额",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
