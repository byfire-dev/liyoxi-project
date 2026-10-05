// 后台：套餐积分与财务 · pricing-changes（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPricingChangeList = adminMeta({
  method: "get",
  path: "/admin/pricing-changes",
  operationId: "admin.pricingChange.list",
  summary: "“积分价模板与参数”变更记录：合并返回等级模板价与计费参数两类历史（按变更集聚合）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPricingChangeCreate = adminMeta({
  method: "post",
  path: "/admin/pricing-changes",
  operationId: "admin.pricingChange.create",
  summary:
    "保存“积分价模板与参数”变更集：等级模板价（4 档，S ≥ A ≥ B ≥ C）与计费参数 [{key, value, effectiveAt}] 在同一事务写两类修订；按模板定价的剧同步变价；计费规则类同事务建公告",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
