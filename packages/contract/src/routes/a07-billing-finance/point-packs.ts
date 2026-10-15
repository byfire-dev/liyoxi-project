// 后台：套餐积分与财务 · point-packs（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull, okResponse, errorResponses } from "../../common/index.js";
const integer = z.int().max(2147483647);
export const PointPackCreateBodySchema = z.object({
  points: integer.min(100),
  priceFen: integer.positive(),
  position: integer.optional(),
});
export const PointPackUpdateBodySchema = PointPackCreateBodySchema.partial().extend({
  lockVersion: z.int().nonnegative(),
});
export const PointPackParamsSchema = z.object({ pointPackId: IdSchema });
export const PointPackAdminQuerySchema = z.object({
  isListed: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export const PointPackRowSchema = z.object({
  pointPackId: IdSchema,
  points: integer.min(100),
  priceFen: integer.positive(),
  isListed: z.boolean(),
  position: integer,
  soldThisMonthCount: z.int().nonnegative(),
  soldThisMonthFen: z.string().regex(/^\d+$/),
  lockVersion: z.int().nonnegative(),
  updatedAt: InstantSchema,
  actions: z.array(z.enum(["update", "shelve", "delist"])),
});
export const PointPackAdminListSchema = z.object({ items: z.array(PointPackRowSchema) });
export const PointPackSummarySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  topupCount: z.int().nonnegative(),
  topupFen: z.string().regex(/^\d+$/),
  topupEntityCount: z.int().nonnegative(),
  topupRateBp: orNull(z.int().min(0).max(10000)),
  monthly: z
    .array(
      z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        points: z.int().nonnegative(),
        isCurrent: z.boolean(),
      }),
    )
    .length(6),
});
export type PointPackCreateBody = z.infer<typeof PointPackCreateBodySchema>;
export type PointPackUpdateBody = z.infer<typeof PointPackUpdateBodySchema>;
export type PointPackAdminQuery = z.infer<typeof PointPackAdminQuerySchema>;
export type PointPackRow = z.infer<typeof PointPackRowSchema>;

export const adminPointPackList = adminRoute({
  method: "get",
  path: "/admin/point-packs",
  operationId: "admin.pointPack.list",
  summary: "积分包列表（积分、价格、单价、本月售出、状态）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: PointPackAdminQuerySchema },
  responses: { ...okResponse(PointPackAdminListSchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminPointPackCreate = adminRoute({
  method: "post",
  path: "/admin/point-packs",
  operationId: "admin.pointPack.create",
  summary: "新增积分包（新增即上架；积分 ≥100、上架中不重复）",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: PointPackCreateBodySchema } },
    },
  },
  responses: { ...okResponse(PointPackRowSchema), ...errorResponses(400, 401, 403, 409, 429) },
});

export const adminPointPackSummary = adminRoute({
  method: "get",
  path: "/admin/point-packs/summary",
  operationId: "admin.pointPack.summary",
  summary: "积分包页 KPI 与近 6 个月加购积分柱状图数据",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  responses: { ...okResponse(PointPackSummarySchema), ...errorResponses(400, 401, 403, 429) },
});

export const adminPointPackUpdate = adminRoute({
  method: "patch",
  path: "/admin/point-packs/{pointPackId}",
  operationId: "admin.pointPack.update",
  summary: "编辑积分包（之后的购买生效；未支付付款单按原价）",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
  request: {
    params: PointPackParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: PointPackUpdateBodySchema } },
    },
  },
  responses: { ...okResponse(PointPackRowSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});

export const adminPointPackDelist = adminRoute({
  method: "post",
  path: "/admin/point-packs/{pointPackId}/delist",
  operationId: "admin.pointPack.delist",
  summary: "下架积分包",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
  request: { params: PointPackParamsSchema },
  responses: { ...okResponse(PointPackRowSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});

export const adminPointPackShelve = adminRoute({
  method: "post",
  path: "/admin/point-packs/{pointPackId}/shelve",
  operationId: "admin.pointPack.shelve",
  summary: "上架积分包",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
  request: { params: PointPackParamsSchema },
  responses: { ...okResponse(PointPackRowSchema), ...errorResponses(400, 401, 403, 404, 409, 429) },
});
