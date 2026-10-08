// 仅本域 Banner 使用。主干尚无共用 DeepLink 表；取 d6 2.4/2.10 与 m08 2.1 已明确的键与参数。
import { IdSchema, DateSchema } from "../../common/index.js";
import { z } from "../../zod.js";
const entry = <R extends string, P extends z.ZodType>(route: R, params: P) =>
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

/** Banner已登记页面的中文名称；未知路由不会借标签表获得访问许可。 */
export const BANNER_PAGE_LABELS: Readonly<Record<string, string>> = {
  "order.detail": "订购详情",
  "delivery.sample": "样片确认",
  "delivery.plan": "制作计划",
  "publish.task": "上线任务",
  "offline.task": "下架任务",
  "ticket.detail": "工单详情",
  "account.detail": "账号详情",
  "asset.demand": "素材需求",
  "wallet.home": "积分钱包",
  "cart.list": "选剧单",
  "ad.detail": "广告详情",
  "profile.review": "门店资料",
  "store.members": "门店成员",
};
