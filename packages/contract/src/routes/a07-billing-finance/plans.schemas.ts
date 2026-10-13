import { z } from "../../zod.js";
import { IdSchema, InstantSchema, openEnum } from "../../common/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import { PLAN_SCOPE } from "../../enums/billing.js";
import { PRODUCTION_MODEL, SCHEDULE_PRIORITY } from "../../enums/shared.js";

const count = z.int().nonnegative();
export const PlanParamsSchema = z.object({ planId: IdSchema });
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
export type PlanAdminColumn = z.infer<typeof PlanAdminColumnSchema>;
export type PlanAdminListQuery = z.infer<typeof PlanAdminListQuerySchema>;
export type PlanNameUpdateBody = z.infer<typeof PlanNameUpdateBodySchema>;
