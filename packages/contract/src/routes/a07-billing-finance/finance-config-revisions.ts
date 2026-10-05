// 后台：套餐积分与财务 · finance-config-revisions（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminFinanceConfigRevisionList = adminMeta({
  method: "get",
  path: "/admin/finance-config-revisions",
  operationId: "admin.financeConfigRevision.list",
  summary:
    "受控财务配置：当前生效值（tab=current；对公收款账户账号脱敏、购买入口策略、内控开关组）与版本列表（含待审提议）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminFinanceConfigRevisionCreate = adminMeta({
  method: "post",
  path: "/admin/finance-config-revisions",
  operationId: "admin.financeConfigRevision.create",
  summary: "提议变更受控配置（同事务建审批单；同一个键同时只允许一张待审）",
  "x-permission": "finance.config.propose",
  "x-idempotent": "required",
});

export const adminFinanceConfigRevisionApprove = adminMeta({
  method: "post",
  path: "/admin/finance-config-revisions/{financeConfigRevisionId}/approve",
  operationId: "admin.financeConfigRevision.approve",
  summary: "批准受控财务配置变更（收款账户批准 24 小时后生效）",
  "x-permission": "finance.config.approve",
  "x-idempotent": "required",
});

export const adminFinanceConfigRevisionReject = adminMeta({
  method: "post",
  path: "/admin/finance-config-revisions/{financeConfigRevisionId}/reject",
  operationId: "admin.financeConfigRevision.reject",
  summary: "驳回受控财务配置变更（说明必填）",
  "x-permission": "finance.config.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminFinanceConfigRevisionWithdraw = adminMeta({
  method: "post",
  path: "/admin/finance-config-revisions/{financeConfigRevisionId}/withdraw",
  operationId: "admin.financeConfigRevision.withdraw",
  summary: "撤回待审的受控财务配置提议（提议人本人；发起人已停用时代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
