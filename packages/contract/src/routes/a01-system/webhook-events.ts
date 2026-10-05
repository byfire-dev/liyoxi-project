// 后台：登录、员工、权限与系统 · webhook-events（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminWebhookEventList = adminMeta({
  method: "get",
  path: "/admin/webhook-events",
  operationId: "admin.webhookEvent.list",
  summary: "回调收件箱查询（失败、死信）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminWebhookEventRetry = adminMeta({
  method: "post",
  path: "/admin/webhook-events/{webhookEventId}/retry",
  operationId: "admin.webhookEvent.retry",
  summary: "把死信回调重置为待处理（attempts 清零）",
  "x-permission": "flow.ops.manage",
  "x-idempotent": "required",
});
