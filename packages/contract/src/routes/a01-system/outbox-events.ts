// 后台：登录、员工、权限与系统 · outbox-events（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminOutboxEventRetry = adminMeta({
  method: "post",
  path: "/admin/outbox-events/{outboxEventId}/retry",
  operationId: "admin.outboxEvent.retry",
  summary: "把某个出站事件对某订阅者的死信重新投递（body 带 subscriber）",
  "x-permission": "flow.ops.manage",
  "x-idempotent": "required",
});
