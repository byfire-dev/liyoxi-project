// 仅本域 Banner 使用。主干尚无共用 DeepLink 表；取 d6 2.4/2.10 与 m08 2.1 已明确的键与参数。
import { IdSchema, DateSchema } from "../../common/index.js";
import { z } from "../../zod.js";
const entry = <R extends string>(route: R, params: z.ZodType) =>
  z.strictObject({ route: z.literal(route), params });
const store = z.strictObject({ storeId: IdSchema });
export const BannerPageJumpSchema = z.union([
  entry("order.detail", z.strictObject({ orderId: IdSchema, storeId: IdSchema })),
  entry("delivery.sample", z.strictObject({ orderItemId: IdSchema, storeId: IdSchema })),
  entry("delivery.plan", z.strictObject({ deliveryPlanId: IdSchema, storeId: IdSchema })),
  entry(
    "publish.task",
    z.strictObject({ launchTaskId: IdSchema, storeId: IdSchema, date: DateSchema.optional() }),
  ),
  entry("offline.task", z.strictObject({ takedownTaskId: IdSchema, storeId: IdSchema })),
  entry("ticket.detail", z.strictObject({ serviceTicketId: IdSchema, storeId: IdSchema })),
  entry("account.detail", z.strictObject({ channelAccountId: IdSchema, storeId: IdSchema })),
  entry("asset.demand", z.strictObject({ storeAssetDemandId: IdSchema, storeId: IdSchema })),
  entry("wallet.home", z.strictObject({})),
  entry("cart.list", store),
  entry("ad.detail", z.strictObject({ adId: IdSchema, storeId: IdSchema })),
  entry("profile.review", store),
  entry("store.members", store),
]);

// 各跳转类型与参数成对验证，禁用额外参数；未知参数规则留待共用 DeepLink 契约落地。
export const BannerJumpSchema = z.discriminatedUnion("jumpKind", [
  z.strictObject({
    jumpKind: z.literal("drama"),
    jumpTarget: z.strictObject({ dramaId: IdSchema }),
  }),
  z.strictObject({
    jumpKind: z.literal("mall"),
    jumpTarget: z.strictObject({ categoryKey: z.string().min(1) }),
  }),
  z.strictObject({ jumpKind: z.literal("page"), jumpTarget: BannerPageJumpSchema }),
  z.strictObject({ jumpKind: z.literal("none"), jumpTarget: z.null() }),
]);
