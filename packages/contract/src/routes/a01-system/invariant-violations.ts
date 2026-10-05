// 后台：登录、员工、权限与系统 · invariant-violations（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminInvariantViolationList = adminMeta({
  method: "get",
  path: "/admin/invariant-violations",
  operationId: "admin.invariantViolation.list",
  summary: "未解决的不变量违规列表与明细（账本、付款、工单、员工等各模块登记的检查项）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminInvariantViolationResolve = adminMeta({
  method: "post",
  path: "/admin/invariant-violations/{invariantViolationId}/resolve",
  operationId: "admin.invariantViolation.resolve",
  summary: "为一条违规填写处理结论并标记已处理",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
