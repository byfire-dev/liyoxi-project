import { z } from "../../zod.js";
import { IdSchema, InstantSchema, DateSchema } from "../../common/index.js";
import { MallConfigSchema, HomeRecommendConfigSchema } from "../../config/schemas.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
export const SiteConfigKeySchema = z.enum(["mall", "home_recommend"]);
const content = z.union([MallConfigSchema, HomeRecommendConfigSchema]);
const chars = (n: number) => z.string().refine((v) => [...v].length <= n);
export const SiteConfigParamsSchema = z.object({ configKey: SiteConfigKeySchema });
export const SiteConfigDraftBodySchema = z.strictObject({
  content,
  baseRevNo: z.int().positive(),
  note: chars(100).optional(),
  lockVersion: z.int().nonnegative().nullable(),
});
export const SiteConfigPublishBodySchema = z.strictObject({
  lockVersion: z.int().nonnegative(),
  baseRevNo: z.int().positive(),
});
export const SiteConfigRevisionViewSchema = z.object({
  siteConfigRevisionId: IdSchema,
  revNo: z.int().positive(),
  status: z.enum(["published", "archived"]),
  content,
  note: z.string().nullable(),
  publishedAt: InstantSchema,
  publishedBy: StaffBriefSchema.nullable(),
});
export const SiteConfigDraftViewSchema = z.object({
  siteConfigRevisionId: IdSchema,
  baseRevNo: z.int().positive().nullable(),
  content,
  note: z.string().nullable(),
  lockVersion: z.int().nonnegative(),
  createdBy: StaffBriefSchema.nullable(),
  updatedAt: InstantSchema,
});
export const ConfigRefIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  reason: z.enum([
    "genre_unknown",
    "genre_disabled",
    "industry_unknown",
    "drama_not_found",
    "drama_not_listed",
    "drama_not_orderable",
  ]),
});
export const SiteConfigRefsSchema = z.object({
  categoryStats: z.array(
    z.object({
      key: z.string(),
      dramaCount: z.int().nonnegative(),
      genreNames: z.array(z.string()),
    }),
  ),
  pins: z.array(
    z.object({
      industryCode: z.string(),
      industryName: z.string(),
      dramaId: IdSchema,
      dramaTitle: z.string(),
      isOrderable: z.boolean(),
    }),
  ),
  invalidRefs: z.array(ConfigRefIssueSchema),
  affectedBanners: z.array(
    z.object({ homeBannerId: IdSchema, title: z.string(), categoryKey: z.string() }),
  ),
});
export const SiteConfigViewSchema = z.object({
  configKey: SiteConfigKeySchema,
  published: SiteConfigRevisionViewSchema,
  draft: SiteConfigDraftViewSchema.nullable(),
  refs: SiteConfigRefsSchema,
});
const page = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
export const SiteConfigRevisionsQuerySchema = z.object({
  ...page,
  status: z
    .string()
    .regex(/^(published|archived)(,(published|archived))*$/)
    .optional(),
});
export const SiteConfigRevisionsPageSchema = z.object({
  items: z.array(SiteConfigRevisionViewSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int().nonnegative(),
});
export const HomeBannerParamsSchema = z.object({ homeBannerId: IdSchema });
const bannerInput = {
  title: chars(30).refine((v) => v.trim().length > 0),
  imageFileId: IdSchema,
  startAt: InstantSchema,
  endAt: InstantSchema.nullable().optional(),
  isEnabled: z.boolean().optional(),
};
export const HomeBannerCreateBodySchema = z.strictObject({
  ...bannerInput,
  jumpKind: z.enum(["drama", "mall", "page", "none"]),
  jumpTarget: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const HomeBannerUpdateBodySchema = z.strictObject({
  title: bannerInput.title.optional(),
  imageFileId: IdSchema.optional(),
  startAt: InstantSchema.optional(),
  endAt: InstantSchema.nullable().optional(),
  isEnabled: z.boolean().optional(),
  jumpKind: z.enum(["drama", "mall", "page", "none"]).optional(),
  jumpTarget: z.record(z.string(), z.unknown()).nullable().optional(),
  lockVersion: z.int().nonnegative(),
});
export const HomeBannerReorderBodySchema = z.strictObject({
  homeBannerIds: z
    .array(IdSchema)
    .min(1)
    .max(200)
    .refine((v) => new Set(v).size === v.length),
});
export const HomeBannerListQuerySchema = z.object({
  ...page,
  pageSize: page.pageSize.default(100),
  displayState: z
    .string()
    .regex(/^(live|scheduled|ended|disabled)(,(live|scheduled|ended|disabled))*$/)
    .optional(),
  isEnded: z
    .union([z.enum(["true", "false"]), z.boolean()])
    .transform((v) => v === true || v === "true")
    .optional(),
  sort: z.enum(["position", "-startAt", "-createdAt"]).default("position"),
});
export const HomeBannerItemSchema = z.object({
  homeBannerId: IdSchema,
  title: z.string(),
  imageFileId: IdSchema,
  imageUrl: SignedUrlSchema.nullable(),
  jumpKind: z.enum(["drama", "mall", "page", "none"]),
  jumpTarget: z.record(z.string(), z.unknown()).nullable(),
  jumpTargetLabel: z.string().nullable(),
  startAt: InstantSchema,
  endAt: InstantSchema.nullable(),
  isEnabled: z.boolean(),
  position: z.int().nonnegative(),
  displayState: z.enum(["live", "scheduled", "ended", "disabled"]),
  clickCount: z.int().nonnegative().nullable(),
  lockVersion: z.int().nonnegative(),
  createdBy: StaffBriefSchema,
  updatedBy: StaffBriefSchema.nullable(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  actions: z.array(z.enum(["edit", "enable", "disable"])),
});
export const HomeBannerMutationSchema = HomeBannerItemSchema.extend({ replayed: z.boolean() });
export const HomeBannerPageSchema = z.object({
  items: z.array(HomeBannerItemSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int().nonnegative(),
});
export const HomeBannerReorderResultSchema = z.object({
  items: z.array(HomeBannerItemSchema),
  replayed: z.boolean(),
});
export const HomeBannerSummarySchema = z.object({
  live: z.int().nonnegative(),
  scheduled: z.int().nonnegative(),
  ended: z.int().nonnegative(),
  disabled: z.int().nonnegative(),
  maxActive: z.int().positive(),
});
export const SiteNoticeQuerySchema = z.object({
  ...page,
  kind: z
    .string()
    .regex(
      /^(plan_revision|billing_param|agreement_version)(,(plan_revision|billing_param|agreement_version))*$/,
    )
    .optional(),
  refId: IdSchema.optional(),
  status: z.enum(["announced", "withdrawn"]).optional(),
  displayState: z
    .string()
    .regex(/^(scheduled|effective|withdrawn)(,(scheduled|effective|withdrawn))*$/)
    .optional(),
  effectiveFrom: DateSchema.optional(),
  effectiveTo: DateSchema.optional(),
  sort: z.enum(["-announcedAt", "-effectiveAt"]).default("-announcedAt"),
});
export const SiteNoticeItemSchema = z.object({
  siteNoticeId: IdSchema,
  kind: z.enum(["plan_revision", "billing_param", "agreement_version"]),
  refId: IdSchema,
  title: z.string(),
  summary: z.string(),
  summaryNoPrice: z.string().nullable(),
  effectiveAt: InstantSchema,
  announcedAt: InstantSchema,
  leadDays: z.int(),
  shortNoticeReason: z.string().nullable(),
  link: z.object({ route: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
  isBarEnabled: z.boolean(),
  status: z.enum(["announced", "withdrawn"]),
  displayState: z.enum(["scheduled", "effective", "withdrawn"]),
  createdBy: StaffBriefSchema,
  withdrawnBy: StaffBriefSchema.nullable(),
  withdrawnAt: InstantSchema.nullable(),
  createdAt: InstantSchema,
});
export const SiteNoticePageSchema = z.object({
  items: z.array(SiteNoticeItemSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int().nonnegative(),
});
export type SiteConfigRefs = z.infer<typeof SiteConfigRefsSchema>;
export type SiteConfigView = z.infer<typeof SiteConfigViewSchema>;
export type HomeBannerItem = z.infer<typeof HomeBannerItemSchema>;
export type HomeBannerCreateBody = z.infer<typeof HomeBannerCreateBodySchema>;
export type HomeBannerUpdateBody = z.infer<typeof HomeBannerUpdateBodySchema>;
