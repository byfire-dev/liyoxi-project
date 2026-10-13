// 后台：登录、员工、权限与系统 · purge-runs（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  PurgeRunListQuerySchema,
  PurgeRunPageSchema,
  PurgeRunViewSchema,
  PurgeRunIdParamsSchema,
  PurgeApproveBodySchema,
  PurgeRejectBodySchema,
} from "./purge-runs.schemas.js";

export const adminPurgeRunList = adminRoute({
  method: "get",
  path: "/admin/purge-runs",
  operationId: "admin.purgeRun.list",
  summary: "文件清除运行的待确认清单（上线初期人工放行）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: PurgeRunListQuerySchema },
  responses: { ...okResponse(PurgeRunPageSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminPurgeRunApprove = adminRoute({
  method: "post",
  path: "/admin/purge-runs/{purgeRunId}/approve",
  operationId: "admin.purgeRun.approve",
  summary: "放行一次清除运行",
  "x-permission": "files.purge.approve",
  "x-idempotent": "required",
  request: {
    params: PurgeRunIdParamsSchema,
    body: { required: true, content: { "application/json": { schema: PurgeApproveBodySchema } } },
  },
  responses: { ...okResponse(PurgeRunViewSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});

export const adminPurgeRunReject = adminRoute({
  method: "post",
  path: "/admin/purge-runs/{purgeRunId}/reject",
  operationId: "admin.purgeRun.reject",
  summary: "驳回一次清除运行",
  "x-permission": "files.purge.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
  request: {
    params: PurgeRunIdParamsSchema,
    body: { required: true, content: { "application/json": { schema: PurgeRejectBodySchema } } },
  },
  responses: { ...okResponse(PurgeRunViewSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});
