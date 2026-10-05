// 后台：登录、员工、权限与系统 · invariant-runs（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminInvariantRunList = adminMeta({
  method: "get",
  path: "/admin/invariant-runs",
  operationId: "admin.invariantRun.list",
  summary: "不变量校验运行记录",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminInvariantRunCreate = adminMeta({
  method: "post",
  path: "/admin/invariant-runs",
  operationId: "admin.invariantRun.create",
  summary: "手动触发一次不变量校验（可限定主体）",
  "x-permission": "flow.ops.manage",
  "x-idempotent": "required",
});
