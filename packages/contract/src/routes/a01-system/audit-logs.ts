// 后台：登录、员工、权限与系统 · audit-logs（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAuditLogList = adminMeta({
  method: "get",
  path: "/admin/audit-logs",
  operationId: "admin.auditLog.list",
  summary: "操作日志列表：时间范围、类型、操作人（含“系统”），游标分页",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAuditLogGet = adminMeta({
  method: "get",
  path: "/admin/audit-logs/{auditLogId}",
  operationId: "admin.auditLog.get",
  summary: "操作日志详情：键值、变更前后、登录方式、来源 IP（脱敏）、关联页面",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
