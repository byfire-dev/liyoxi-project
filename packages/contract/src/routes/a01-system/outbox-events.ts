// 后台：登录、员工、权限与系统 · outbox-events（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { IdSchema, errorResponses, okResponse } from "../../common/index.js";
import { z } from "../../zod.js";
import { OutboxRetryBodySchema, OutboxDeliveryViewSchema } from "./flow-ops.schemas.js";

export const adminOutboxEventRetry = adminRoute({
  method: "post",
  path: "/admin/outbox-events/{outboxEventId}/retry",
  operationId: "admin.outboxEvent.retry",
  summary: "把某个出站事件对某订阅者的死信重新投递（body 带 subscriber）",
  "x-permission": "flow.ops.manage",
  "x-idempotent": "required",
  request: {
    params: z.object({ outboxEventId: IdSchema }),
    body: { content: { "application/json": { schema: OutboxRetryBodySchema } } },
  },
  responses: {
    ...okResponse(OutboxDeliveryViewSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});
