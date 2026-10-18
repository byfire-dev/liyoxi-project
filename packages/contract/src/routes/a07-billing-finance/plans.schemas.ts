import { z } from "../../zod.js";
import {
  DateSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  openEnum,
} from "../../common/index.js";
import { PlanQuoteSchema } from "../m07-billing/purchase.schemas.js";
import { adminPage, StaffBriefSchema } from "../a01-system/structures.js";
import { PLAN_SCOPE } from "../../enums/billing.js";
import { PRODUCTION_MODEL, SCHEDULE_PRIORITY } from "../../enums/shared.js";

const count = z.int().nonnegative();
const text = (max: number) =>
  z
    .string()
    .trim()
    .refine((v) => [...v].length >= 1 && [...v].length <= max);
const status = z.enum(["pending", "effective", "superseded", "cancelled"]);
export const PlanParamsSchema = z.object({ planId: IdSchema });
export const PlanRevisionParamsSchema = z.object({ planRevisionId: IdSchema });
export const PlanCreateBodySchema = z
  .strictObject({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,23}$/),
    name: text(20),
    rank: z.int().min(1).max(99),
  })
  .openapi("PlanCreateBody");
export const PlanRevisionCreateBodySchema = z
  .strictObject({
    monthlyFeeFen: z.int().positive().max(2_147_483_647),
    monthlyPoints: z.int().positive().max(2_147_483_647),
    discountBp: z.int().min(5000).max(10000).multipleOf(100),
    productionModel: z.enum(PRODUCTION_MODEL.values),
    maxStores: z.int().positive().max(2_147_483_647),
    maxMembers: z.int().positive().max(2_147_483_647).nullable(),
    schedulePriority: z.enum(SCHEDULE_PRIORITY.values),
    hasMonthlyReport: z.boolean(),
    cyclePrices: z
      .array(
        z.strictObject({
          months: z.int().positive(),
          priceFen: z.int().positive().max(2_147_483_647),
        }),
      )
      .refine((v) => new Set(v.map((p) => p.months)).size === v.length)
      .optional(),
    effectiveDate: DateSchema.nullable(),
    firstCyclePromo: z.boolean(),
    notice: z
      .strictObject({
        title: text(40).optional(),
        summary: text(200).optional(),
        summaryNoPrice: text(200).optional(),
        isBarEnabled: z.boolean().optional(),
      })
      .nullable()
      .optional(),
  })
  .openapi("PlanRevisionCreateBody");
export const PlanRevisionWithdrawBodySchema = z
  .strictObject({
    note: z.string().trim().max(200).optional(),
    confirm: z.strictObject({ planRevisionId: IdSchema, effectiveAt: InstantSchema }),
  })
  .openapi("PlanRevisionWithdrawBody");
export const PlanRevisionListQuerySchema = PageQuerySchema.extend({
  planId: IdSchema.optional(),
  status: z
    .union([status, z.array(status)])
    .transform((v) => (typeof v === "string" ? [v] : v))
    .optional(),
}).openapi("PlanRevisionListQuery");
export const PlanAdminListQuerySchema = z
  .object({
    includeDelisted: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional()
      .default(true),
  })
  .openapi("PlanAdminListQuery");
export const PlanNameUpdateBodySchema = z
  .strictObject({
    lockVersion: count,
    name: z
      .string()
      .trim()
      .refine((v) => [...v].length >= 1 && [...v].length <= 20),
  })
  .openapi("PlanNameUpdateBody");
export const PlanRevisionViewSchema = z
  .object({
    planRevisionId: IdSchema,
    planId: IdSchema,
    revisionNo: z.int().positive(),
    monthlyFeeFen: z.int().positive(),
    monthlyPoints: z.int().positive(),
    discountBp: z.int().min(5000).max(10000),
    productionModel: openEnum(PRODUCTION_MODEL.values),
    maxStores: z.int().positive(),
    maxMembers: z.int().nonnegative().nullable(),
    schedulePriority: openEnum(SCHEDULE_PRIORITY.values),
    hasMonthlyReport: z.boolean(),
    cyclePrices: z.array(z.object({ months: z.int().positive(), priceFen: z.int().positive() })),
    hasFirstCyclePromo: z.boolean(),
    effectiveAt: InstantSchema,
    status: openEnum(["pending", "effective", "superseded", "cancelled"]),
    cancelledAt: InstantSchema.nullable(),
    notice: z
      .object({
        siteNoticeId: IdSchema,
        title: z.string(),
        summary: z.string(),
        summaryNoPrice: z.string().nullable(),
        status: openEnum(["announced", "withdrawn"]),
        announcedAt: InstantSchema,
        leadDays: count,
      })
      .nullable(),
    createdBy: StaffBriefSchema.nullable(),
    createdAt: InstantSchema,
    actions: z.array(z.enum(["withdraw"])),
  })
  .openapi("PlanRevisionView");
export const PlanAdminColumnSchema = z
  .object({
    planId: IdSchema,
    code: z.string(),
    name: z.string(),
    rank: z.int().positive(),
    scope: openEnum(PLAN_SCOPE.values),
    isListed: z.boolean(),
    columnStatus: openEnum(["pending_change", "listed", "delisted", "draft"]),
    current: PlanRevisionViewSchema.nullable(),
    pending: PlanRevisionViewSchema.nullable(),
    activeEntityCount: count,
    newThisMonthCount: count,
    renewedThisMonthCount: count,
    lockVersion: count,
    actions: z.array(z.enum(["create-plan-revision", "update", "shelve", "delist"])),
  })
  .openapi("PlanAdminColumn");
export const PlanAdminListSchema = z
  .object({
    items: z.array(PlanAdminColumnSchema),
    enabledCycles: z.object({
      current: z.array(z.int().positive()),
      pending: z
        .object({
          billingParamId: IdSchema,
          value: z.array(z.int().positive()),
          effectiveAt: InstantSchema,
        })
        .nullable(),
    }),
  })
  .openapi("PlanAdminList");
export const PlanRevisionListItemSchema = PlanRevisionViewSchema.extend({
  plan: z.object({ planId: IdSchema, name: z.string() }),
});
export const PlanRevisionPageSchema = adminPage(PlanRevisionListItemSchema).openapi(
  "PlanRevisionPage",
);
export const PlanSummarySchema = z
  .object({
    activeEntityCount: count,
    mrrFen: z.string().regex(/^\d+$/),
    newThisMonthCount: count,
    renewedThisMonthCount: count,
    asOf: InstantSchema,
  })
  .openapi("PlanSummary");
export type PlanAdminColumn = z.infer<typeof PlanAdminColumnSchema>;
export type PlanAdminListQuery = z.infer<typeof PlanAdminListQuerySchema>;
export type PlanNameUpdateBody = z.infer<typeof PlanNameUpdateBodySchema>;
export type PlanRevisionCreateBody = z.infer<typeof PlanRevisionCreateBodySchema>;
export type PlanRevisionListQuery = z.infer<typeof PlanRevisionListQuerySchema>;

export const PlanAdminQuoteBodySchema = z
  .strictObject({
    kind: z.enum(["upgrade", "renewal"]),
    planId: IdSchema,
    pointAccountId: IdSchema.optional(),
    months: z.int().positive().optional(),
    intent: z.enum(["upgrade_now", "renew_next_term"]).optional(),
    fromPlanId: IdSchema.optional(),
    remainingDays: z.int().min(1).max(30).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.kind === "renewal" && body.months === undefined)
      ctx.addIssue({ code: "custom", path: ["months"], message: "请选择购买周期" });
    if (body.kind === "upgrade" && body.pointAccountId === undefined) {
      if (body.fromPlanId === undefined)
        ctx.addIssue({ code: "custom", path: ["fromPlanId"], message: "请选择当前版本" });
      if (body.remainingDays === undefined)
        ctx.addIssue({ code: "custom", path: ["remainingDays"], message: "请填写本月剩余天数" });
    }
  })
  .openapi("PlanAdminQuoteBody");
const genericUpgrade = z.object({
  feeDeltaPerMonthFen: count,
  monthlyDeltaPoints: count,
  remainingDays: z.int().positive(),
  baseDays: z.int().positive(),
  proratedFen: count,
  topupPoints: count,
  formulaText: z.string(),
});
const genericRenewal = z.object({
  cyclePriceFen: z.int().positive(),
  monthlyPoints: count,
  months: z.int().positive(),
  formulaText: z.string(),
});
export const PlanAdminQuoteSchema = z
  .discriminatedUnion("scope", [
    z.object({ scope: z.literal("entity"), quote: PlanQuoteSchema, generic: z.null() }),
    z.object({
      scope: z.literal("generic"),
      quote: z.null(),
      generic: z.union([genericUpgrade, genericRenewal]),
    }),
  ])
  .openapi("PlanAdminQuote");
export type PlanAdminQuoteBody = z.infer<typeof PlanAdminQuoteBodySchema>;
export type PlanAdminQuote = z.infer<typeof PlanAdminQuoteSchema>;
