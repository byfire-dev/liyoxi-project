// 后台：套餐积分与财务 · plan-revisions（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPlanRevisionList = adminMeta({
  method: "get",
  path: "/admin/plan-revisions",
  operationId: "admin.planRevision.list",
  summary: "套餐调整与公告记录（待生效、已生效、已撤销）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPlanRevisionWithdraw = adminMeta({
  method: "post",
  path: "/admin/plan-revisions/{planRevisionId}/withdraw",
  operationId: "admin.planRevision.withdraw",
  summary: "生效前撤销价目修订，同事务撤回公告",
  "x-permission": "billing.plan.edit",
  "x-idempotent": "required",
});
