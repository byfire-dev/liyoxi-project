// 后台：登录、员工、权限与系统 · staff-sessions（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { adminPage } from "./structures.js";
import {
  StaffSessionListQuerySchema,
  StaffSessionViewSchema,
  StaffSessionIdParamsSchema,
  StaffSessionRevokeBodySchema,
} from "./staff-full.schemas.js";

export const adminStaffSessionList = adminRoute({
  method: "get",
  path: "/admin/staff-sessions",
  operationId: "admin.staffSession.list",
  summary: "在线会话列表",
  "x-permission": "sys.session.revoke",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: StaffSessionListQuerySchema },
  responses: {
    ...okResponse(adminPage(StaffSessionViewSchema)),
    ...errorResponses(400, 401, 403, 429),
  },
});

export const adminStaffSessionRevoke = adminRoute({
  method: "post",
  path: "/admin/staff-sessions/{staffSessionId}/revoke",
  operationId: "admin.staffSession.revoke",
  summary: "强制下线某个会话",
  "x-permission": "sys.session.revoke",
  "x-idempotent": "required",
  request: {
    params: StaffSessionIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: StaffSessionRevokeBodySchema } },
    },
  },
  responses: {
    ...okResponse(StaffSessionViewSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});
