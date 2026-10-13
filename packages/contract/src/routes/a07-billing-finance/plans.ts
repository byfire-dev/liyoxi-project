// 后台：套餐积分与财务 · plans（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  PlanAdminListSchema,
  PlanAdminListQuerySchema,
  PlanParamsSchema,
  PlanAdminColumnSchema,
  PlanNameUpdateBodySchema,
  PlanCreateBodySchema,
  PlanRevisionCreateBodySchema,
  PlanRevisionViewSchema,
  PlanSummarySchema,
} from "./plans.schemas.js";

export const adminPlanList = adminRoute({
  method: "get",
  path: "/admin/plans",
  operationId: "admin.plan.list",
  summary: "套餐版本与权益矩阵（当前价目、待生效价目、上下架状态）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: PlanAdminListQuerySchema },
  responses: { ...okResponse(PlanAdminListSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminPlanCreate = adminRoute({
  method: "post",
  path: "/admin/plans",
  operationId: "admin.plan.create",
  summary: "新建套餐版本（先建价目修订再上架）",
  "x-permission": "billing.plan.edit",
  "x-idempotent": "required",
  request: {
    body: { content: { "application/json": { schema: PlanCreateBodySchema } }, required: true },
  },
  responses: { ...okResponse(PlanAdminColumnSchema), ...errorResponses(400, 401, 403, 409, 429) },
});

export const adminPlanQuote = adminMeta({
  method: "post",
  path: "/admin/plans/quote",
  operationId: "admin.plan.quote",
  summary:
    "升级补差或续费试算（请求体区分升级与续费；与商家端选择套餐同一实现）：版本、周期 → 算式、新周期、每月积分、应付金额",
  "x-permission": "assert-in-handler",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminPlanSummary = adminRoute({
  method: "get",
  path: "/admin/plans/summary",
  operationId: "admin.plan.summary",
  summary: "套餐页 KPI：套餐生效家数、月度经常性收入、本月新开通、本月续费",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  responses: { ...okResponse(PlanSummarySchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminPlanUpdate = adminRoute({
  method: "patch",
  path: "/admin/plans/{planId}",
  operationId: "admin.plan.update",
  summary: "改套餐版本名称（只改 plan.name；code、rank 创建后不改，价格与权益走价目修订）",
  "x-permission": "billing.plan.edit",
  "x-idempotent": "required",
  "x-idempotent-reason": "带 lockVersion 的 PATCH（A17）",
  request: {
    params: PlanParamsSchema,
    body: { content: { "application/json": { schema: PlanNameUpdateBodySchema } }, required: true },
  },
  responses: {
    ...okResponse(PlanAdminColumnSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});

export const adminPlanDelist = adminRoute({
  method: "post",
  path: "/admin/plans/{planId}/delist",
  operationId: "admin.plan.delist",
  summary: "套餐下架（不可新购与续费，已有周期不受影响）",
  "x-permission": "billing.plan.edit",
  "x-idempotent": "required",
  request: { params: PlanParamsSchema },
  responses: {
    ...okResponse(PlanAdminColumnSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});

export const adminPlanPlanRevisionCreate = adminRoute({
  method: "post",
  path: "/admin/plans/{planId}/plan-revisions",
  operationId: "admin.plan.planRevision.create",
  summary:
    "编辑版本：月费、积分、折扣、门店与成员上限、制作模型、生效日期（≥今天 + 30 天）、首期优惠；同事务建规则变更公告",
  "x-permission": "billing.plan.edit",
  "x-idempotent": "required",
  request: {
    params: PlanParamsSchema,
    body: {
      content: { "application/json": { schema: PlanRevisionCreateBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(PlanRevisionViewSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});

export const adminPlanShelve = adminRoute({
  method: "post",
  path: "/admin/plans/{planId}/shelve",
  operationId: "admin.plan.shelve",
  summary: "套餐上架（可新购与续费）",
  "x-permission": "billing.plan.edit",
  "x-idempotent": "required",
  request: { params: PlanParamsSchema },
  responses: {
    ...okResponse(PlanAdminColumnSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429),
  },
});
