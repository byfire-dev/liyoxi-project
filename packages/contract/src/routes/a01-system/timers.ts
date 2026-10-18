// 后台：登录、员工、权限与系统 · timers（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { IdSchema, errorResponses, okResponse } from "../../common/index.js";
import { z } from "../../zod.js";
import {
  TimerListQuerySchema,
  TimerPageSchema,
  TimerViewSchema,
  TimerCancelBodySchema,
  FlowOpsNoteBodySchema,
} from "./flow-ops.schemas.js";

export const adminTimerList = adminRoute({
  method: "get",
  path: "/admin/timers",
  operationId: "admin.timer.list",
  summary: "定时器查询：失败、待触发，按对象类型与 id 过滤",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: TimerListQuerySchema },
  responses: { ...okResponse(TimerPageSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminTimerCancel = adminRoute({
  method: "post",
  path: "/admin/timers/{timerId}/cancel",
  operationId: "admin.timer.cancel",
  summary: "把失败的定时器标记为不再需要（原因必填，写审计）",
  "x-permission": "flow.ops.manage",
  "x-idempotent": "required",
  request: {
    params: z.object({ timerId: IdSchema }),
    body: { content: { "application/json": { schema: TimerCancelBodySchema } } },
  },
  responses: { ...okResponse(TimerViewSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});

export const adminTimerReschedule = adminRoute({
  method: "post",
  path: "/admin/timers/{timerId}/reschedule",
  operationId: "admin.timer.reschedule",
  summary: "定时器重新排期（失败或需改期的定时器）",
  "x-permission": "flow.ops.manage",
  "x-idempotent": "required",
  request: {
    params: z.object({ timerId: IdSchema }),
    body: { content: { "application/json": { schema: FlowOpsNoteBodySchema } } },
  },
  responses: { ...okResponse(TimerViewSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});
