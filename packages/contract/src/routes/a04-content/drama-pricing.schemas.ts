// W3-10; a04 §2.11 / §3.31–3.36. Inputs are strict; list queries use wire CSV.
import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  PageQuerySchema,
  openEnum,
} from "../../common/index.js";
import { adminPage, StaffBriefSchema } from "../a01-system/structures.js";
import {
  DRAMA_PRICE_REVISION_MODE,
  DRAMA_PRICE_REVISION_REASON_CODE,
} from "../../enums/billing.js";
import { HEAT_TIER } from "../../enums/shared.js";
const count = z.int().nonnegative();
const mode = z.enum(DRAMA_PRICE_REVISION_MODE.values);
const reason = z.enum(DRAMA_PRICE_REVISION_REASON_CODE.values);
const text = (max: number) => z.string().refine((v) => [...v].length <= max);
const csv = (values: readonly string[]) =>
  z
    .string()
    .min(1)
    .max(1000)
    .refine((v) => v.split(",").every((p) => values.includes(p)))
    .transform((v) => [...new Set(v.split(","))]);
export const DramaPriceCreateBodySchema = z
  .strictObject({
    mode,
    customPoints: z.int().min(100).nullable().optional(),
    effectiveDate: DateSchema.nullable(),
    reasonCode: reason,
    note: text(200).nullable().optional(),
    confirm: z.strictObject({ currentPoints: count.nullable() }),
  })
  .superRefine((v, c) => {
    if ((v.mode === "template") !== (v.customPoints == null))
      c.addIssue({
        code: "custom",
        path: ["customPoints"],
        message: "按模板必须为空，单剧价必须填写",
      });
    if ((v.mode === "template") !== (v.reasonCode === "restore_template"))
      c.addIssue({ code: "custom", path: ["reasonCode"], message: "恢复模板价与模板模式成对" });
  })
  .openapi("DramaPriceCreateBody");
export const DramaPriceNoteBodySchema = z
  .strictObject({ note: text(200).nullable().optional() })
  .openapi("DramaPriceNoteBody");
export const PlanPriceSchema = z
  .object({
    planId: IdSchema,
    planCode: z.string(),
    planName: z.string(),
    discountBp: z.int().min(0).max(10000),
    discountedPoints: count.nullable(),
  })
  .openapi("PlanPrice");
export const CurrentDramaPriceRevisionSchema = z.object({
  dramaPriceRevisionId: IdSchema,
  mode: openEnum(["template", "custom"]),
  reasonCode: openEnum(DRAMA_PRICE_REVISION_REASON_CODE.values),
  note: z.string().nullable(),
  effectiveAt: InstantSchema,
});
export const PendingDramaPriceRevisionSchema = z.object({
  dramaPriceRevisionId: IdSchema,
  newPoints: count,
  effectiveAt: InstantSchema,
});
export const DramaPricingSchema = z
  .object({
    listPricePoints: count.nullable(),
    priceMode: openEnum(["template", "custom"]).nullable(),
    templatePoints: count.nullable(),
    currentRevision: CurrentDramaPriceRevisionSchema.omit({ note: true }).nullable(),
    pendingRevisions: z.array(PendingDramaPriceRevisionSchema),
    tierTemplates: z.array(z.object({ tier: openEnum(HEAT_TIER.values), points: count })),
    planPrices: z.array(PlanPriceSchema),
  })
  .openapi("DramaPricing");
export const DramaPriceRowSchema = z
  .object({
    dramaId: IdSchema,
    title: z.string(),
    status: openEnum(["draft", "listed", "delisted"]),
    archivedAt: InstantSchema.nullable(),
    heatTier: openEnum(HEAT_TIER.values).nullable(),
    templatePoints: count.nullable(),
    listPricePoints: count.nullable(),
    priceMode: openEnum(["template", "custom"]).nullable(),
    currentRevision: CurrentDramaPriceRevisionSchema.nullable(),
    pricedSince: InstantSchema.nullable(),
    pendingRevision: PendingDramaPriceRevisionSchema.nullable(),
    planPrices: z.array(PlanPriceSchema),
    licenseEndDate: DateSchema.nullable(),
    stopOrderDate: DateSchema.nullable(),
    licenseFlag: openEnum(["orderable", "stopped", "license_ended", "not_listed"]),
    isExpiringSoon: z.boolean(),
    canCreatePriceRevision: z.boolean(),
    priceLockReason: openEnum(["stopped", "license_ended", "archived"]).nullable(),
  })
  .openapi("DramaPriceRow");
export const DramaPriceRevisionSchema = z
  .object({
    dramaPriceRevisionId: IdSchema,
    dramaId: IdSchema,
    dramaTitle: z.string(),
    mode: openEnum(DRAMA_PRICE_REVISION_MODE.values),
    customPoints: count.nullable(),
    prevPoints: count.nullable(),
    newPoints: count,
    effectiveAt: InstantSchema,
    reasonCode: openEnum(DRAMA_PRICE_REVISION_REASON_CODE.values),
    note: z.string().nullable(),
    state: openEnum(["pending", "effective", "withdrawn"]),
    cancelledAt: InstantSchema.nullable(),
    createdBy: StaffBriefSchema,
    createdAt: InstantSchema,
    actions: z.array(openEnum(["withdraw"])),
  })
  .openapi("DramaPriceRevision");
export const DramaPriceListQuerySchema = PageQuerySchema.extend({
  q: text(20).optional(),
  dramaId: z
    .string()
    .max(2000)
    .refine(
      (v) =>
        v.split(",").length <= 50 && v.split(",").every((id) => IdSchema.safeParse(id).success),
    )
    .transform((v) => [...new Set(v.split(","))])
    .optional(),
  heatTier: csv(HEAT_TIER.values).optional(),
  priceMode: mode.optional(),
  status: csv(["draft", "listed", "delisted"]).optional(),
  isArchived: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
  sort: z
    .enum(["heatTier,title", "heatTier", "title", "-listPricePoints", "-pricedSince"])
    .default("heatTier,title"),
}).openapi("DramaPriceListQuery");
export const DramaPriceSummaryQuerySchema = DramaPriceListQuerySchema.omit({
  page: true,
  pageSize: true,
  sort: true,
}).openapi("DramaPriceSummaryQuery");
export const DramaPriceRevisionListQuerySchema = PageQuerySchema.extend({
  dramaId: IdSchema.optional(),
  state: csv(["pending", "effective", "withdrawn"]).optional(),
  sort: z.enum(["-effectiveAt", "-createdAt"]).default("-effectiveAt"),
}).openapi("DramaPriceRevisionListQuery");
export const DramaPricePageSchema = adminPage(DramaPriceRowSchema).openapi("DramaPricePage");
export const DramaPriceRevisionPageSchema =
  adminPage(DramaPriceRevisionSchema).openapi("DramaPriceRevisionPage");
export const DramaPriceSummarySchema = z
  .object({
    listed: count,
    customPriced: count,
    ordersMonth: count,
    statRefreshedAt: InstantSchema.nullable(),
    minLicenseMonths: count,
  })
  .openapi("DramaPriceSummary");
export const PriceTierRowSchema = z
  .object({
    priceTierRevisionId: IdSchema,
    tier: openEnum(HEAT_TIER.values),
    points: count,
    effectiveAt: InstantSchema,
    batchId: IdSchema,
    createdBy: StaffBriefSchema.nullable(),
    createdAt: InstantSchema,
    dramaCount: count,
    templateDramaCount: count,
  })
  .openapi("PriceTierRow");
export const PriceTierListSchema = z
  .object({ items: z.array(PriceTierRowSchema).length(4) })
  .openapi("PriceTierList");
export const DramaPriceCreateResultSchema = z
  .object({ revision: DramaPriceRevisionSchema, price: DramaPriceRowSchema })
  .openapi("DramaPriceCreateResult");
export type DramaPriceCreateBody = z.infer<typeof DramaPriceCreateBodySchema>;
export type DramaPriceListQuery = z.infer<typeof DramaPriceListQuerySchema>;
export type DramaPriceRevisionListQuery = z.infer<typeof DramaPriceRevisionListQuerySchema>;
export type DramaPriceRow = z.infer<typeof DramaPriceRowSchema>;
export type DramaPriceRevision = z.infer<typeof DramaPriceRevisionSchema>;
export type DramaPricing = z.infer<typeof DramaPricingSchema>;

export type DramaPriceCreateResult = z.infer<typeof DramaPriceCreateResultSchema>;
export type DramaPricePage = z.infer<typeof DramaPricePageSchema>;
export type DramaPriceSummary = z.infer<typeof DramaPriceSummarySchema>;
export type DramaPriceRevisionPage = z.infer<typeof DramaPriceRevisionPageSchema>;
export type PriceTierList = z.infer<typeof PriceTierListSchema>;
