// 付款单内容快照、履约结果、订阅事件细节（W1-11a）。三个 jsonb 列的结构：
//   billing_order.content_snapshot    BillingOrderContent（07 分组 第 4.8 节；08 分组 第 4.1 节）
//   billing_order.fulfillment_result  FulfillResult（08 分组 第 4.3 节）
//   subscription_event.payload        SubscriptionEventPayload（07 分组 第 4.4 节）
// 快照由报价函数生成、付款单原样保存；履约只读快照与快照指向的修订行，不回查现价。
import {
  BpSchema,
  DateSchema,
  FenSchema,
  IdSchema,
  InstantSchema,
  orNull,
  PointsSchema,
} from "../common/scalars.js";
import { z } from "../zod.js";
import { SubscriptionDailySnapshotSchema } from "./subscription-snapshot.js";

const months = z.int().positive();
const payFen = FenSchema.positive();

/** 首期优惠：claimRevisionId 是带优惠位的那一版（占用记在它名下），appliedRevisionId 是这次沿用的上一版 */
export const planPromoSchema = z.strictObject({
  claimRevisionId: IdSchema,
  type: z.literal("previous_revision"),
  appliedRevisionId: IdSchema,
});

/** 套餐（开通、续费、降级续费） */
export const planOrderContentSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("plan"),
  planId: IdSchema,
  /** W1-11b：创建时名称；旧快照缺项兼容回查，不参与履约计价。 */
  planName: z.string().optional(),
  planRevisionId: IdSchema,
  months,
  /** 周期总价 */
  cyclePriceFen: FenSchema.positive(),
  /** 应付 */
  payFen,
  monthlyPoints: PointsSchema.positive(),
  discountBp: BpSchema.min(5000).max(10000),
  promo: orNull(planPromoSchema),
  quotedAt: InstantSchema,
});

/** 升级补差：履约只按这份算式，不看“现在是第几个月” */
export const upgradeOrderContentSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("upgrade"),
  termId: IdSchema,
  fromPlanRevisionId: IdSchema,
  toPlanRevisionId: IdSchema,
  quotedAt: InstantSchema,
  quotedOn: DateSchema,
  monthIndex: z.int().nonnegative(),
  remainingDays: z.int().nonnegative(),
  baseDays: z.int().positive(),
  remainingFullMonths: z.int().nonnegative(),
  feeDeltaPerMonthFen: FenSchema,
  pointsDeltaPerMonth: PointsSchema,
  proratedFen: FenSchema.nonnegative(),
  payFen,
  topupPoints: PointsSchema.nonnegative(),
  validUntil: InstantSchema,
});

/** 加购积分 */
export const topupOrderContentSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("topup"),
  packId: IdSchema,
  points: PointsSchema.positive(),
  payFen,
});

export const billingOrderContentSchema = z.discriminatedUnion("kind", [
  planOrderContentSchema,
  upgradeOrderContentSchema,
  topupOrderContentSchema,
]);
export type BillingOrderContent = z.infer<typeof billingOrderContentSchema>;
export type PlanOrderContent = z.infer<typeof planOrderContentSchema>;

/** 履约受阻的原因码（D1 第 6.4 节）。前四个是业务前提变了，后四个是程序缺陷或数据异常 */
export const FULFILL_BLOCK_REASONS = [
  "UPGRADE_TERM_CHANGED",
  "UPGRADE_PLAN_CHANGED",
  "UPGRADE_QUOTE_EXPIRED",
  "PLAN_REFUND_IN_PROGRESS",
  "AMOUNT_MISMATCH",
  "ADVANCE_FAILED",
  "SELF_CHECK_FAILED",
  "CONSTRAINT_VIOLATION",
  "UNEXPECTED",
] as const;
export type FulfillBlockReason = (typeof FULFILL_BLOCK_REASONS)[number];

/** 履约完成时的标注 */
export const FULFILL_NOTES = ["promo_already_claimed"] as const;
export type FulfillNote = (typeof FULFILL_NOTES)[number];

export const fulfillDoneSchema = z.strictObject({
  status: z.literal("done"),
  /** 周期的生效时刻：新开通、过期后重新开通 = 履约时刻；排在生效周期后面的 = 上一期的止点 */
  effectiveAt: InstantSchema,
  /** 履约出的周期；加购没有 */
  termId: orNull(IdSchema),
  /** 这次履约当场入账的批次 */
  lotIds: z.array(IdSchema).max(50),
  /** 已有生效周期，多排了一个预约周期 */
  queuedBehindActive: z.boolean(),
  notes: z.array(z.enum(FULFILL_NOTES)).max(10),
});

export const fulfillBlockedSchema = z.strictObject({
  status: z.literal("blocked"),
  reasonCode: z.enum(FULFILL_BLOCK_REASONS),
  /** 排查信息：只给财务与工程看，不出商家端 */
  detail: z.record(z.string(), z.unknown()),
});

export const fulfillResultSchema = z.discriminatedUnion("status", [
  fulfillDoneSchema,
  fulfillBlockedSchema,
]);
export type FulfillResult = z.infer<typeof fulfillResultSchema>;
export type FulfillDone = z.infer<typeof fulfillDoneSchema>;
export type FulfillBlocked = z.infer<typeof fulfillBlockedSchema>;

/**
 * subscription_event.payload，按 type。这里登记 M1 会写的几种：续接带新周期的名额；
 * 开通、续费预约、降级预约、过期没有细节（列为空）。升级、延长、退款一族的随 M4 增补。
 */
export const SUBSCRIPTION_EVENT_PAYLOADS = {
  rolled_over: z.strictObject({
    maxStores: z.int().positive(),
    maxMembers: orNull(z.int().nonnegative()),
    dailySnapshot: SubscriptionDailySnapshotSchema.optional(),
  }),
  activated: z
    .strictObject({ dailySnapshot: SubscriptionDailySnapshotSchema.optional() })
    .nullable(),
  renewal_scheduled: z
    .strictObject({ dailySnapshot: SubscriptionDailySnapshotSchema.optional() })
    .nullable(),
  downgrade_scheduled: z
    .strictObject({ dailySnapshot: SubscriptionDailySnapshotSchema.optional() })
    .nullable(),
  expired: z.strictObject({ dailySnapshot: SubscriptionDailySnapshotSchema.optional() }).nullable(),
  upgraded: z.strictObject({
    monthIndex: z.int().nonnegative(),
    remainingDays: z.int().nonnegative(),
    baseDays: z.int().positive(),
    remainingFullMonths: z.int().nonnegative(),
    feeDeltaPerMonthFen: FenSchema.nonnegative(),
    pointsDeltaPerMonth: PointsSchema.nonnegative(),
    proratedFen: FenSchema.nonnegative(),
    payFen: FenSchema.positive(),
    topupPoints: PointsSchema.nonnegative(),
    dailySnapshot: SubscriptionDailySnapshotSchema.optional(),
  }),
  extended: z.strictObject({
    requestNo: z.string().min(1).max(64),
    days: z.int().min(1).max(90),
    appliedSubscriptionTermId: IdSchema,
    appliedMode: z.literal("extend"),
    prevEndDate: DateSchema,
    newEndDate: DateSchema,
    dailySnapshot: SubscriptionDailySnapshotSchema.optional(),
  }),
  resumed: z.strictObject({
    requestNo: z.string().min(1).max(64),
    days: z.int().min(1).max(90),
    gapDays: z.int().nonnegative(),
    appliedSubscriptionTermId: IdSchema,
    appliedMode: z.literal("revive"),
    prevEndDate: DateSchema,
    newEndDate: DateSchema,
    dailySnapshot: SubscriptionDailySnapshotSchema.optional(),
  }),
} as const satisfies Record<string, z.ZodType>;
export type SubscriptionEventPayloadType = keyof typeof SUBSCRIPTION_EVENT_PAYLOADS;
export type SubscriptionEventPayload<
  T extends SubscriptionEventPayloadType = SubscriptionEventPayloadType,
> = z.infer<(typeof SUBSCRIPTION_EVENT_PAYLOADS)[T]>;
