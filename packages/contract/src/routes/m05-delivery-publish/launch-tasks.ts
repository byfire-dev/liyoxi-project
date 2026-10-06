// 商家端：交付与发布 · launch-tasks（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。

export const mLaunchTaskList = merchantRoute({
  method: "get",
  path: "/m/launch-tasks",
  operationId: "m.launchTask.list",
  summary:
    "上线任务（?tab=todo|done&orderId=&orderItemId=）：按订单聚合，约定上线日与剩余天数、成片包摘要、逐剧逐账号状态（待发布/核验中/需补充/已通过）与核验结果",
  "x-capability": "publish.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: LaunchTaskListQuerySchema },
  responses: {
    ...okResponse(LaunchTaskPageSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mLaunchTaskSummary = merchantRoute({
  method: "get",
  path: "/m/launch-tasks/summary",
  operationId: "m.launchTask.summary",
  summary: "发布任务页“待上线 N / 已完成 N”中上线任务一侧的计数，键与列表 tab 取值一致",
  "x-capability": "publish.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: LaunchFilterQuerySchema },
  responses: {
    ...okResponse(LaunchTaskSummarySchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mLaunchTaskGet = merchantRoute({
  method: "get",
  path: "/m/launch-tasks/{launchTaskId}",
  operationId: "m.launchTask.get",
  summary:
    "上线记录（一个账号）：上线日期、发布方式、链接、核验项与结论、回填与核验时间线、作品巡检记录与检查项",
  "x-capability": "publish.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { params: LaunchTaskParamSchema },
  responses: {
    ...okResponse(LaunchTaskDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mLaunchTaskSubmit = merchantRoute({
  method: "post",
  path: "/m/launch-tasks/{launchTaskId}/submit",
  operationId: "m.launchTask.submit",
  summary: "回填上线链接并提交核验：{collectionUrl 或逐集作品链接, actualLaunchDate, episodeCount}",
  "x-capability": "publish.submit_link",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: LaunchTaskParamSchema,
    body: {
      content: { "application/json": { schema: LaunchTaskSubmitBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(LaunchTaskCardSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  LaunchFilterQuerySchema,
  LaunchTaskCardSchema,
  LaunchTaskDetailSchema,
  LaunchTaskListQuerySchema,
  LaunchTaskPageSchema,
  LaunchTaskParamSchema,
  LaunchTaskSubmitBodySchema,
  LaunchTaskSummarySchema,
} from "./publish.schemas.js";
