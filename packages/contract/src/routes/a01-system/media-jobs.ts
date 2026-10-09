// 后台：登录、员工、权限与系统 · media-jobs（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { IdSchema, errorResponses, okResponse } from "../../common/index.js";
import { z } from "../../zod.js";
import {
  MediaJobListQuerySchema,
  MediaJobPageSchema,
  MediaJobViewSchema,
  MediaJobNoteBodySchema,
} from "./media-jobs.schemas.js";

export const adminMediaJobList = adminRoute({
  method: "get",
  path: "/admin/media-jobs",
  operationId: "admin.mediaJob.list",
  summary: "媒体任务监控（失败列表：转码、体检、OCR、打包等）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: MediaJobListQuerySchema },
  responses: { ...okResponse(MediaJobPageSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminMediaJobRetry = adminRoute({
  method: "post",
  path: "/admin/media-jobs/{mediaJobId}/retry",
  operationId: "admin.mediaJob.retry",
  summary: "媒体任务人工重试",
  "x-permission": "media.job.retry",
  "x-idempotent": "required",
  request: {
    params: z.object({ mediaJobId: IdSchema }),
    body: { content: { "application/json": { schema: MediaJobNoteBodySchema } } },
  },
  responses: { ...okResponse(MediaJobViewSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});
