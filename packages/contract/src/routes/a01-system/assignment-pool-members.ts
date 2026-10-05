// 后台：登录、员工、权限与系统 · assignment-pool-members（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAssignmentPoolMemberList = adminMeta({
  method: "get",
  path: "/admin/assignment-pool-members",
  operationId: "admin.assignmentPoolMember.list",
  summary: "分配池成员：交付经理（按城市）、剪辑师、发布专员、客服（含当班开关）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
