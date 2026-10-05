// 后台：登录、员工、权限与系统 · staff-sessions（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminStaffSessionList = adminMeta({
  method: "get",
  path: "/admin/staff-sessions",
  operationId: "admin.staffSession.list",
  summary: "在线会话列表",
  "x-permission": "sys.session.revoke",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminStaffSessionRevoke = adminMeta({
  method: "post",
  path: "/admin/staff-sessions/{staffSessionId}/revoke",
  operationId: "admin.staffSession.revoke",
  summary: "强制下线某个会话",
  "x-permission": "sys.session.revoke",
  "x-idempotent": "required",
});
