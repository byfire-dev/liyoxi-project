// 后台：登录、员工、权限与系统 · alerts（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAlertList = adminMeta({
  method: "get",
  path: "/admin/alerts",
  operationId: "admin.alert.list",
  summary: "未恢复告警列表（状态、级别、来源、认领人）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAlertAcknowledge = adminMeta({
  method: "post",
  path: "/admin/alerts/{alertId}/acknowledge",
  operationId: "admin.alert.acknowledge",
  summary: "认领告警",
  "x-permission": "sys.health.manage",
  "x-idempotent": "required",
});

export const adminAlertResolve = adminMeta({
  method: "post",
  path: "/admin/alerts/{alertId}/resolve",
  operationId: "admin.alert.resolve",
  summary: "人工关闭告警（必填说明，不发通知）",
  "x-permission": "sys.health.manage",
  "x-idempotent": "required",
});
