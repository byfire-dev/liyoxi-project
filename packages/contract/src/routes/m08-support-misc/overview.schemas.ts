// m08 第 2.4 节：观察者角色决定结构，店员对象用 strip（C55）。
import {
  DateSchema,
  DictRefSchema,
  IdSchema,
  InstantSchema,
  openEnum,
  orNull,
} from "../../common/index.js";
import {
  CHANNEL_ACCOUNT_ABNORMAL_SOURCE,
  CHANNEL_PLATFORM,
  MERCHANT_ROLE,
  STORE_LIFECYCLE,
  QUALIFICATION_STATUS,
} from "../../enums/index.js";
import { z } from "../../zod.js";

const count = z.int().nonnegative();
const storeShape = {
  storeId: IdSchema,
  name: orNull(z.string()),
  isPrimary: z.boolean(),
  lifecycle: openEnum(STORE_LIFECYCLE.values),
  qualificationStatus: openEnum(QUALIFICATION_STATUS.values),
  city: orNull(DictRefSchema),
  category: orNull(DictRefSchema),
  role: openEnum(MERCHANT_ROLE.values),
  assetCount: count,
  clerkCount: count,
};
export const OverviewStoreForClerkSchema = z.object(storeShape).openapi("OverviewStoreForClerk");
export const OverviewStoreSchema = z
  .object({
    ...storeShape,
    completenessPct: z.int().min(0).max(100),
    review: orNull(
      z.object({ submittedAt: InstantSchema, expectedDecisionAt: orNull(InstantSchema) }),
    ),
  })
  .openapi("OverviewStore");
export const OverviewPlanCardSchema = z
  .object({
    status: openEnum(["none", "active", "expired"]),
    isRefundPending: z.boolean(),
    planName: orNull(z.string()),
    endDate: orNull(DateSchema),
    remainingDays: orNull(count),
    spendablePoints: count,
    planAvailablePoints: count,
    addonAvailablePoints: count,
    planPointsExpireAt: orNull(InstantSchema),
    isAddonSuspended: z.boolean(),
  })
  .openapi("OverviewPlanCard");
export const ChannelAccountAttentionSchema = z
  .object({
    channelAccountId: IdSchema,
    platform: openEnum(CHANNEL_PLATFORM.values),
    status: openEnum(["abnormal", "pending_verify"]),
    abnormalSource: orNull(openEnum(CHANNEL_ACCOUNT_ABNORMAL_SOURCE.values)),
    abnormalReason: orNull(DictRefSchema),
  })
  .openapi("ChannelAccountAttention");
export const MeOverviewOwnerSchema = z
  .object({
    viewerRole: z.literal("owner"),
    currentStore: OverviewStoreSchema,
    subscription: OverviewPlanCardSchema,
    stores: z.object({
      visibleCount: count,
      storeLimit: count,
      reviewingStores: z.array(z.object({ storeId: IdSchema, name: orNull(z.string()) })),
    }),
    storeStats: z.object({ liveCount: count, deliveringCount: count, cartCount: count }),
    entries: z.object({
      adPendingConfirmCount: count,
      launchTaskTodoCount: count,
      hasLaunchTasks: z.boolean(),
      channelAccountCount: count,
      channelAccountAttention: orNull(ChannelAccountAttentionSchema),
      ticketAwaitingConfirmCount: count,
    }),
    unreadMessageCount: count,
  })
  .openapi("MeOverview");
export const MeOverviewForClerkSchema = z
  .object({
    viewerRole: z.literal("clerk"),
    currentStore: OverviewStoreForClerkSchema,
    stores: z.object({ visibleCount: count }),
    unreadMessageCount: count,
  })
  .openapi("MeOverviewForClerk");
export const MeOverviewSchema = z.discriminatedUnion("viewerRole", [
  MeOverviewOwnerSchema,
  MeOverviewForClerkSchema,
]);
export type MeOverview = z.infer<typeof MeOverviewSchema>;
