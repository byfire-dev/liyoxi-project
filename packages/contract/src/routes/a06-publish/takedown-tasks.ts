// 后台：发布与巡检 · takedown-tasks（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";

import {
  AdminTakedownTaskListQuerySchema,
  AdminTakedownTaskSummaryQuerySchema,
  AdminTakedownTaskPageSchema,
  AdminTakedownTaskSummarySchema,
  TakedownTaskParamSchema,
  TakedownTaskDetailSchema,
  TakedownTaskBatchCheckBodySchema,
  TakedownTaskBatchCheckResultSchema,
  TakedownTaskCheckBodySchema,
  TakedownTaskNoteBodySchema,
  TakedownTaskBreachNoticeBodySchema,
} from "./takedown-m6.schemas.js";

export const adminTakedownTaskList = adminRoute({
  method: "get",
  path: "/admin/takedown-tasks",
  operationId: "admin.takedownTask.list",
  summary: "下架核查队列：待核查、已核查（逾期、今日截止标记）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: AdminTakedownTaskListQuerySchema },
  responses: {
    ...okResponse(AdminTakedownTaskPageSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminTakedownTaskBatchCheck = adminRoute({
  method: "post",
  path: "/admin/takedown-tasks/check",
  operationId: "admin.takedownTask.batchCheck",
  summary: "批量核查下架（每个任务各带证据截图）",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
  request: {
    body: {
      content: { "application/json": { schema: TakedownTaskBatchCheckBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(TakedownTaskBatchCheckResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminTakedownTaskSummary = adminRoute({
  method: "get",
  path: "/admin/takedown-tasks/summary",
  operationId: "admin.takedownTask.summary",
  summary: "下架核查页签计数：待核查、已核查（含逾期、今日截止）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: AdminTakedownTaskSummaryQuerySchema },
  responses: {
    ...okResponse(AdminTakedownTaskSummarySchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminTakedownTaskGet = adminRoute({
  method: "get",
  path: "/admin/takedown-tasks/{takedownTaskId}",
  operationId: "admin.takedownTask.get",
  summary: "下架任务详情：使用期、结束依据、下架方式与商家确认、处理记录、证据截图",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: TakedownTaskParamSchema },
  responses: {
    ...okResponse(TakedownTaskDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminTakedownTaskCheck = adminRoute({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/check",
  operationId: "admin.takedownTask.check",
  summary: "核查通过（清单全过，证据截图 ≥2 张，长期留存）；全部账号核查后工单归档",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
  request: {
    params: TakedownTaskParamSchema,
    body: {
      content: { "application/json": { schema: TakedownTaskCheckBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(TakedownTaskDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminTakedownTaskEscalate = adminRoute({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/escalate",
  operationId: "admin.takedownTask.escalate",
  summary: "逾期未下架手动升级（通知交付主管与交付经理）",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
  request: {
    params: TakedownTaskParamSchema,
    body: {
      content: { "application/json": { schema: TakedownTaskNoteBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(TakedownTaskDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminTakedownTaskMarkOnline = adminRoute({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/mark-online",
  operationId: "admin.takedownTask.markOnline",
  summary: "抽查仍在线：记录结果、通知商家、升级交付主管",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
  request: {
    params: TakedownTaskParamSchema,
    body: {
      content: { "application/json": { schema: TakedownTaskNoteBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(TakedownTaskDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminTakedownTaskSendBreachNotice = adminRoute({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/send-breach-notice",
  operationId: "admin.takedownTask.sendBreachNotice",
  summary: "发送违约提醒：要求 24 小时内删除作品或设为仅自己可见（限频）",
  "x-permission": "publish.takedown.breach_notice",
  "x-idempotent": "required",
  request: {
    params: TakedownTaskParamSchema,
    body: {
      content: { "application/json": { schema: TakedownTaskBreachNoticeBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(TakedownTaskDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});
