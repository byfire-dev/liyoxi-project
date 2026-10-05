// 后台：登录、员工、权限与系统 · pii-reveals（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPiiRevealCreate = adminMeta({
  method: "post",
  path: "/admin/pii-reveals",
  operationId: "admin.piiReveal.create",
  summary: "查看字段明文（手机号、信用代码、银行账号等）：先写 access 审计再返回；限频",
  "x-permission": "assert-in-handler",
  "x-idempotent": "none",
  "x-idempotent-reason": "明文查看，结果含明文，不进幂等记录（A51）",
});
