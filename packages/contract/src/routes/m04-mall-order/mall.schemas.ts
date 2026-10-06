import { IdSchema, DateSchema, InstantSchema, DictRefSchema } from "../../common/index.js";
import { MallConfigSchema, MALL_SORTS } from "../../config/schemas.js";
import { z } from "../../zod.js";
import { BannerJumpSchema } from "./banner.schemas.js";
const count = z.int().nonnegative();
const signed = z.object({ url: z.url(), expiresAt: InstantSchema });
const cardShape = {
  dramaId: IdSchema,
  title: z.string(),
  posterUrl: signed.nullable(),
  genres: z.array(DictRefSchema),
  totalEpisodes: z.int().positive(),
  heatTier: z.enum(["S", "A", "B", "C"]).nullable(),
  badge: z.enum(["new", "hot"]).nullable(),
  listPricePoints: count.nullable(),
  usableUntilDate: DateSchema.nullable(),
};
export const DramaCardSchema = z
  .object({ ...cardShape, discountedPoints: count.nullable() })
  .openapi("DramaCard");
export const DramaCardForClerkSchema = z.object(cardShape).openapi("DramaCardForClerk");
const pageShape = {
  viewerPlan: z.object({ planName: z.string(), discountBp: count }).nullable(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
};
export const DramaPageOwnerSchema = z
  .object({ ...pageShape, viewerRole: z.literal("owner"), items: z.array(DramaCardSchema) })
  .openapi("DramaPageOwner");
export const DramaPageClerkSchema = z
  .object({ ...pageShape, viewerRole: z.literal("clerk"), items: z.array(DramaCardForClerkSchema) })
  .openapi("DramaPageClerk");
export const DramaPageGuestSchema = z
  .object({ ...pageShape, viewerRole: z.literal("guest"), items: z.array(DramaCardForClerkSchema) })
  .openapi("DramaPageGuest");
export const DramaPageSchema = z.discriminatedUnion("viewerRole", [
  DramaPageOwnerSchema,
  DramaPageClerkSchema,
  DramaPageGuestSchema,
]);
export const MallDramaListQuerySchema = z.object({
  q: z
    .string()
    .refine((value) => [...value].length >= 1 && [...value].length <= 20)
    .optional(),
  category: z.string().optional(),
  genreCodes: z.string().optional(),
  industryCodes: z.string().optional(),
  episodeBand: z.string().optional(),
  priceBand: z.string().optional(),
  sort: z.enum(MALL_SORTS).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const MallDramaParamsSchema = z.object({ dramaId: IdSchema });
export const HomeQuerySchema = z.object({ cityCode: z.string().optional() });
export const MallConfigViewSchema = z
  .object({
    revNo: z.int().positive(),
    categories: z.array(
      z.object({ key: z.string(), name: z.string(), genres: z.array(DictRefSchema) }),
    ),
    hotWords: z.array(z.string()).max(8),
    filters: MallConfigSchema.shape.filters,
    sorts: MallConfigSchema.shape.sorts,
    defaultSort: MallConfigSchema.shape.defaultSort,
    genres: z.array(DictRefSchema),
    industries: z.array(DictRefSchema),
  })
  .openapi("MallConfigView");
const detailShape = {
  ...cardShape,
  orderability: z.object({
    orderable: z.boolean(),
    reason: z.enum(["not_listed", "stopped"]).nullable(),
  }),
  episodeDurationSec: z.int().positive().nullable(),
  producerName: z.string().nullable(),
  castNames: z.string().nullable(),
  synopsis: z.string().nullable(),
  roles: z.array(z.object({ name: z.string(), actor: z.string().nullable(), desc: z.string() })),
  industries: z.array(DictRefSchema),
  targetAudience: z.string().nullable(),
  sellingTags: z.array(
    z.object({ code: z.string(), name: z.string(), description: z.string().nullable() }),
  ),
  dramaClass: z.enum(["class_1", "class_2", "class_3"]).nullable(),
  allowedPlacements: z.array(z.enum(["opening", "ending"])),
  placementDurations: z.array(
    z.object({
      slot: z.enum(["opening", "ending"]),
      durationSecOptions: z.array(z.int().positive()),
    }),
  ),
  platforms: z.array(z.enum(["douyin", "wechat_channels"])),
  permits: z.array(
    z.object({
      platform: z.enum(["all", "douyin", "wechat_channels"]),
      kind: z.enum(["license_no", "approval_no", "program_no"]),
      number: z.string(),
    }),
  ),
  adUnitPoints: count,
  topModelSurchargeBp: count,
  trailer: z
    .object({ playableId: IdSchema, posterUrl: signed.nullable(), durationMs: count })
    .nullable(),
};
const owner = z.object({
  planName: z.string().nullable(),
  productionModel: z.enum(["standard", "advanced", "top"]).nullable(),
  discountBp: count.nullable(),
  adDiscountedPoints: count.nullable(),
  spendablePoints: count,
  expiringPlanPoints: count,
  planPointsExpireAt: InstantSchema.nullable(),
  termEndDate: DateSchema.nullable(),
  cartItemId: IdSchema.nullable(),
});
export const DramaDetailOwnerSchema = z
  .object({
    ...detailShape,
    viewerRole: z.literal("owner"),
    discountedPoints: count.nullable(),
    owner: owner.nullable(),
  })
  .openapi("DramaDetailOwner");
export const DramaDetailClerkSchema = z
  .object({ ...detailShape, viewerRole: z.literal("clerk") })
  .openapi("DramaDetailClerk");
export const DramaDetailGuestSchema = z
  .object({ ...detailShape, viewerRole: z.literal("guest") })
  .openapi("DramaDetailGuest");
export const DramaDetailSchema = z.discriminatedUnion("viewerRole", [
  DramaDetailOwnerSchema,
  DramaDetailClerkSchema,
  DramaDetailGuestSchema,
]);
const bannerFields = { homeBannerId: IdSchema, title: z.string(), imageUrl: signed };
const banner = z.discriminatedUnion("jumpKind", [
  BannerJumpSchema.options[0].extend(bannerFields),
  BannerJumpSchema.options[1].extend(bannerFields),
  BannerJumpSchema.options[2].extend(bannerFields),
  BannerJumpSchema.options[3].extend(bannerFields),
]);
const commonHome = { city: DictRefSchema.nullable(), banners: z.array(banner).max(5) };
const guestHome = {
  ...commonHome,
  hot: z.array(DramaCardForClerkSchema),
  new: z.array(DramaCardForClerkSchema),
  defaultTab: z.enum(["hot", "new"]),
};
export const HomeClerkSchema = z
  .object({ ...commonHome, viewerRole: z.literal("clerk") })
  .openapi("HomeClerk");
export const HomeGuestSchema = z
  .object({ ...guestHome, viewerRole: z.literal("guest") })
  .openapi("HomeGuest");
export const HomeOwnerSchema = z
  .object({
    ...guestHome,
    viewerRole: z.literal("owner"),
    hot: z.array(DramaCardSchema),
    new: z.array(DramaCardSchema),
    noticeBar: z.null(),
    launchOverview: z
      .object({
        liveItemCount: count,
        liveEpisodeCount: count,
        spendablePoints: count,
        planName: z.string().nullable(),
        termEndDate: DateSchema.nullable(),
        expiringPlanPoints: count,
        planPointsExpireAt: InstantSchema.nullable(),
      })
      .nullable(),
    recommend: z
      .object({
        matchBy: z
          .object({ industry: DictRefSchema, category: DictRefSchema.nullable() })
          .nullable(),
        items: z.array(DramaCardSchema),
      })
      .nullable(),
    cartCount: count,
  })
  .openapi("HomeOwner");
export const HomeSchema = z.discriminatedUnion("viewerRole", [
  HomeOwnerSchema,
  HomeClerkSchema,
  HomeGuestSchema,
]);
export type MallDramaListQuery = z.infer<typeof MallDramaListQuerySchema>;
export type MallConfigView = z.infer<typeof MallConfigViewSchema>;

export type HomeView = z.infer<typeof HomeSchema>;
export type DramaPage = z.infer<typeof DramaPageSchema>;
export type DramaDetail = z.infer<typeof DramaDetailSchema>;
