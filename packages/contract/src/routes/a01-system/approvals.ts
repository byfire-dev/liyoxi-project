// 后台：登录、员工、权限与系统 · approvals（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { IdSchema, errorResponses, okResponse } from "../../common/index.js";
import { z } from "../../zod.js";
import { adminRoute } from "../builders.js";
import {
  ApprovalCountsSchema,
  ApprovalDetailSchema,
  ApprovalFilterSchema,
  ApprovalItemSchema,
  ApprovalListQuerySchema,
} from "./approvals.schemas.js";
import { adminPage } from "./structures.js";

export const adminApprovalList = adminRoute({
  method: "get",
  path: "/admin/approvals",
  operationId: "admin.approval.list",
  summary:
    "审批单列表（跨类型、只读）：按 kind 与页签查询；不带 kind 时为“我的待审批”（待本人决定的各类审批）",
  request: { query: ApprovalListQuerySchema },
  responses: { ...okResponse(adminPage(ApprovalItemSchema)), ...errorResponses(400, 401, 403) },
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminApprovalSummary = adminRoute({
  method: "get",
  path: "/admin/approvals/summary",
  operationId: "admin.approval.summary",
  summary: "各 kind 的待办计数、超时数与本月合计（如本月通过的调整积分增减合计）",
  request: { query: ApprovalFilterSchema },
  responses: { ...okResponse(ApprovalCountsSchema), ...errorResponses(400, 401) },
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminApprovalGet = adminRoute({
  method: "get",
  path: "/admin/approvals/{approvalId}",
  operationId: "admin.approval.get",
  summary: "审批单详情（只读）：摘要快照、决定记录与时限、领域行引用（domain.type / domain.id）",
  request: { params: z.object({ approvalId: IdSchema }) },
  responses: { ...okResponse(ApprovalDetailSchema), ...errorResponses(400, 401, 404) },
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
