// 后台：登录、员工、权限与系统 · outbox-deliveries（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminOutboxDeliveryList = adminMeta({
  method: "get",
  path: "/admin/outbox-deliveries",
  operationId: "admin.outboxDelivery.list",
  summary: "出站投递查询：死信与重试中的投递",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
