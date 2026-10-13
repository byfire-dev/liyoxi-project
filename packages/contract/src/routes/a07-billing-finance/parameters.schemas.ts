import { z } from "../../zod.js";
import {
  DateSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  openEnum,
} from "../../common/index.js";
import { BILLING_PARAM_KEY, HEAT_TIER } from "../../enums/index.js";
import { BILLING_PARAM_VALUES } from "../../billing/params.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import { PlanRevisionCreateBodySchema } from "./plans.schemas.js";
const key = z.enum(BILLING_PARAM_KEY.values);
const value = z.union([
  z.number(),
  z.array(z.int()),
  z.record(z.string(), z.union([z.int(), z.string(), z.null()])),
]);
const item = <K extends keyof typeof BILLING_PARAM_VALUES>(name: K) =>
  z.strictObject({
    key: z.literal(name),
    value: BILLING_PARAM_VALUES[name],
    effectiveDate: DateSchema.nullable().optional(),
  });
export const PricingChangeCreateBodySchema = z
  .strictObject({
    tiers: z
      .strictObject({
        S: z.int().min(100).max(20000),
        A: z.int().min(100).max(20000),
        B: z.int().min(100).max(20000),
        C: z.int().min(100).max(20000),
      })
      .refine((v) => v.S >= v.A && v.A >= v.B && v.B >= v.C)
      .nullable()
      .optional(),
    params: z
      .array(
        z.discriminatedUnion("key", [
          item("adUnitPoints"),
          item("adFreeRevisions"),
          item("topModelSurchargeBp"),
          item("cancelDeductionBp"),
          item("expiredTermRefund"),
          item("minLicenseMonths"),
          item("renewalReminderDays"),
          item("prorationBaseDays"),
          item("planRefundWindowHours"),
          item("enabledCycles"),
          item("maxScheduledTerms"),
          item("noticeDays"),
        ]),
      )
      .max(12)
      .refine((v) => new Set(v.map((p) => p.key)).size === v.length)
      .nullable()
      .optional(),
    notice: PlanRevisionCreateBodySchema.shape.notice,
    note: z.string().trim().max(200).optional(),
  })
  .openapi("PricingChangeCreateBody");
export const BillingParamViewSchema = z
  .object({
    key,
    needsNotice: z.boolean(),
    schema: z.object({
      type: z.enum(["integer", "integer_list", "object"]),
      min: z.number().optional(),
      max: z.number().optional(),
      subKeys: z.record(z.string(), z.unknown()).optional(),
    }),
    defaultValue: value,
    current: z.object({
      billingParamId: IdSchema,
      value,
      effectiveAt: InstantSchema,
      changeId: IdSchema,
      createdBy: StaffBriefSchema.nullable(),
    }),
    pending: z
      .object({
        billingParamId: IdSchema,
        value,
        effectiveAt: InstantSchema,
        changeId: IdSchema,
        siteNoticeId: IdSchema.nullable(),
        createdBy: StaffBriefSchema.nullable(),
      })
      .nullable(),
    actions: z.array(z.literal("withdraw")),
  })
  .openapi("BillingParamView");
export const BillingParamListSchema = z
  .object({
    items: z.array(BillingParamViewSchema),
    noticeDays: z.int().nonnegative(),
    earliestNoticedEffectiveDate: DateSchema,
  })
  .openapi("BillingParamList");
export const BillingParamParamsSchema = z.object({ billingParamId: IdSchema });
export const BillingParamWithdrawBodySchema = z
  .strictObject({
    note: z.string().trim().max(200).optional(),
    confirm: z.strictObject({ key, effectiveAt: InstantSchema }),
  })
  .openapi("BillingParamWithdrawBody");
export const PricingChangeQuerySchema = PageQuerySchema.extend({
  kind: z.enum(["price_tier", "billing_param"]).optional(),
  key: key.optional(),
  createdFrom: DateSchema.optional(),
  createdTo: DateSchema.optional(),
})
  .refine((v) => !v.createdFrom || !v.createdTo || v.createdFrom <= v.createdTo)
  .openapi("PricingChangeQuery");
export const PricingChangeRecordSchema = z
  .object({
    changeSetId: IdSchema,
    createdAt: InstantSchema,
    createdBy: StaffBriefSchema.nullable(),
    note: z.string().nullable(),
    tierItems: z.array(
      z.object({
        priceTierRevisionId: IdSchema,
        tier: openEnum(HEAT_TIER.values),
        previousPoints: z.int().nullable(),
        points: z.int(),
        effectiveAt: InstantSchema,
      }),
    ),
    paramItems: z.array(
      z.object({
        billingParamId: IdSchema,
        key,
        previousValue: value.nullable(),
        value,
        effectiveAt: InstantSchema,
        status: openEnum(["pending", "effective", "superseded", "cancelled"]),
      }),
    ),
    notice: z
      .object({
        siteNoticeId: IdSchema,
        title: z.string(),
        status: openEnum(["announced", "withdrawn"]),
        effectiveAt: InstantSchema,
      })
      .nullable(),
    summaryText: z.string(),
  })
  .openapi("PricingChangeRecord");
export const PricingChangePageSchema =
  adminPage(PricingChangeRecordSchema).openapi("PricingChangePage");
export type PricingChangeCreateBody = z.infer<typeof PricingChangeCreateBodySchema>;
export type PricingChangeQuery = z.infer<typeof PricingChangeQuerySchema>;
