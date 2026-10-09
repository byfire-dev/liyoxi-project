// 后台：登录、员工、权限与系统 · staff-groups（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { StaffGroupListQuerySchema, StaffGroupSummarySchema } from "./staff-full.schemas.js";

export const adminStaffGroupList = adminRoute({
  method: "get",
  path: "/admin/staff-groups",
  operationId: "admin.staffGroup.list",
  summary: "员工分组列表（编辑员工时选分组；“本组”数据范围的组织实体）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: StaffGroupListQuerySchema },
  responses: {
    ...okResponse(z.object({ items: z.array(StaffGroupSummarySchema) })),
    ...errorResponses(400, 401, 403, 429),
  },
});
