import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  DictRefSchema,
  orNull,
  openEnum,
} from "../../common/index.js";

import {
  CHANNEL_PLATFORM,
  CHANNEL_ACCOUNT_ACCOUNT_TYPE,
  CHANNEL_ACCOUNT_STATUS,
  PRODUCTION_MODEL,
  DRAMA_ORDER_STATUS,
  ORDER_ITEM_PHASE,
  USAGE_END_SOURCE,
  DELIVERY_TICKET_STEP,
  DELIVERY_PLAN_STATUS,
  CANCEL_REQUEST_KIND,
  CANCEL_REQUEST_STATUS,
  CANCEL_REQUEST_LINE_MODE,
  CANCEL_REASON_CODE,
  REQUEST_CLOSE_REASON,
} from "../../enums/index.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { DramaCardSchema } from "./mall.schemas.js";
import { UNORDERABLE_REASONS } from "./error-details.js";

const count = z.int().nonnegative();
const positive = z.int().positive();
const uniqueIds = (min: number, max: number) =>
  z
    .array(IdSchema)
    .min(min)
    .max(max)
    .refine((v) => new Set(v).size === v.length, "标识不能重复");
const chars = (max: number) => z.string().refine((v) => [...v].length <= max, `最多 ${max} 字`);
export const OrderExpectSchema = z.object({
  totalChargePoints: count,
  items: z.array(z.object({ dramaId: IdSchema, chargePoints: count })).max(50),
});
export const OrderQuoteBodySchema = z
  .object({
    dramaIds: uniqueIds(1, 50),
    isTopModel: z.boolean().default(false),
    channelAccountIds: uniqueIds(0, 2).optional(),
  })
  .openapi("OrderQuoteBody");
export const OrderCreateBodySchema = z
  .object({
    dramaIds: uniqueIds(1, 50),
    channelAccountIds: uniqueIds(1, 2),
    focusCodes: z
      .array(z.string().min(1))
      .min(1)
      .refine((v) => new Set(v).size === v.length),
    referenceStoreAssetIds: uniqueIds(0, 9).optional(),
    note: chars(200).optional(),
    isTopModel: z.boolean().default(false),
    adIds: uniqueIds(0, 2).optional(),
    expectedLaunchDate: DateSchema.nullable().optional(),
    agreementVersionId: IdSchema,
    expect: OrderExpectSchema,
  })
  .superRefine((v, ctx) => {
    const ids = v.expect.items.map((i) => i.dramaId);
    if (
      ids.length !== v.dramaIds.length ||
      new Set(ids).size !== ids.length ||
      v.dramaIds.some((id) => !ids.includes(id)) ||
      v.expect.totalChargePoints !== v.expect.items.reduce((n, i) => n + i.chargePoints, 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["expect"],
        message: "报价逐部必须与订购剧目一致，合计须为逐部之和",
      });
  })
  .openapi("OrderCreateBody");
export const QuoteBlockerSchema = z
  .object({ code: z.string(), message: z.string(), dramaId: IdSchema.nullable().optional() })
  .openapi("QuoteBlocker");
const placement = z.enum(["opening", "ending"]);
export const OrderQuoteItemSchema = z
  .object({
    drama: DramaCardSchema,
    listPricePoints: count,
    discountBp: count,
    surchargeBp: count,
    chargePoints: count,
    discountDeltaPoints: z.int(),
    surchargeDeltaPoints: count,
    allowedPlacements: z.array(placement),
    platforms: z.array(openEnum(CHANNEL_PLATFORM.values)),
    orderable: z.boolean(),
    unorderableReason: orNull(openEnum(UNORDERABLE_REASONS)),
  })
  .openapi("OrderQuoteItem");
export const OrderQuoteSchema = z
  .object({
    quotedAt: InstantSchema,
    store: z.object({
      storeId: IdSchema,
      storeName: z.string().nullable(),
      entityName: z.string().nullable(),
      isEntityVerified: z.boolean(),
      contactName: z.string().nullable(),
      contactPhoneMask: z.string().nullable(),
    }),
    plan: z.object({
      planCode: z.string(),
      planName: z.string(),
      productionModel: openEnum(PRODUCTION_MODEL.values),
      discountBp: count,
      topModelSurchargeBp: count,
      isTopModelIncluded: z.boolean(),
    }),
    items: z.array(OrderQuoteItemSchema),
    totalChargePoints: count,
    spendablePoints: count,
    pointsShortfall: count,
    allocation: z.object({
      planLots: z.array(z.object({ expiresAt: InstantSchema, points: count })),
      addonPoints: count,
    }),
    balanceAfter: z.object({ planPoints: count, addonPoints: count }),
    channelAccounts: z.array(
      z.object({
        channelAccountId: IdSchema,
        platform: openEnum(CHANNEL_PLATFORM.values),
        accountName: z.string(),
        accountUid: z.string(),
        accountType: orNull(openEnum(CHANNEL_ACCOUNT_ACCOUNT_TYPE.values)),
        status: openEnum(CHANNEL_ACCOUNT_STATUS.values),
        abnormalReason: orNull(DictRefSchema),
        isSelectable: z.boolean(),
      }),
    ),
    ads: z.array(
      z.object({
        adId: IdSchema,
        adNo: z.string(),
        type: placement,
        durationSec: positive,
        copy: z.string().nullable(),
        confirmedVersionNo: positive,
        confirmedAt: InstantSchema,
      }),
    ),
    earliestLaunchDate: DateSchema,
    agreement: z.object({
      agreementKey: z.literal("custom_license"),
      name: z.string(),
      agreementVersionId: IdSchema,
      versionLabel: z.string(),
    }),
    blockers: z.array(QuoteBlockerSchema),
    expect: OrderExpectSchema,
  })
  .openapi("OrderQuote");
export const OrderTodoSchema = z
  .object({
    todoId: z.string(),
    kind: openEnum([
      "plan_confirm",
      "ad_confirm",
      "sample_confirm",
      "launch_submit",
      "takedown_confirm",
      "channel_account_fix",
      "qualification_fix",
      "ticket_confirm",
      "asset_demand",
    ]),
    tag: openEnum(["to_confirm", "to_handle", "failed"]),
    title: z.string(),
    dueAt: InstantSchema.nullable(),
    urgency: openEnum(["overdue", "due_today", "normal"]),
    subjectType: z.string(),
    subjectId: IdSchema,
    orderId: IdSchema.nullable(),
    orderItemId: IdSchema.nullable(),
    link: z.object({ route: z.string(), params: z.record(z.string(), z.string()) }),
  })
  .openapi("OrderTodo");
export const ORDER_TIMELINE_KEYS = [
  "submitted",
  "started",
  "manager_assigned",
  "plan_confirmed",
  "ads_confirmed",
  "sample_confirmed",
  "delivered",
  "live",
  "usage_ended",
] as const;
export const OrderItemInOrderSchema = z
  .object({
    orderItemId: IdSchema,
    itemNo: positive,
    dramaId: IdSchema,
    dramaTitle: z.string(),
    posterUrl: orNull(SignedUrlSchema),
    genres: z.array(DictRefSchema),
    episodeCount: positive,
    phase: openEnum(ORDER_ITEM_PHASE.values),
    phaseChangedAt: InstantSchema,
    ticketStep: orNull(openEnum(DELIVERY_TICKET_STEP.values)),
    listPricePoints: count,
    discountBp: count,
    surchargeBp: count,
    chargePoints: count,
    productionModel: openEnum(PRODUCTION_MODEL.values),
    accounts: z.array(
      z.object({
        channelAccountId: IdSchema,
        platform: openEnum(CHANNEL_PLATFORM.values),
        accountName: z.string(),
      }),
    ),
    placements: z.array(
      z.object({
        slot: placement,
        adId: IdSchema,
        adNo: z.string(),
        durationSec: positive,
        boundVersionNo: positive.nullable(),
      }),
    ),
    agreedLaunchDate: DateSchema.nullable(),
    usageStartDate: DateSchema.nullable(),
    usageEndDate: DateSchema,
    usageEndSource: openEnum(USAGE_END_SOURCE.values),
    liveEpisodeCount: count,
    returnPoints: z.object({
      refundRequestedPoints: count,
      returnedPoints: count,
      convertedPoints: count,
      forfeitedPoints: count,
    }),
    cancelReasonCode: orNull(openEnum(CANCEL_REASON_CODE.values)),
    cancelledAt: InstantSchema.nullable(),
    timeline: z.array(
      z.object({
        key: openEnum(ORDER_TIMELINE_KEYS),
        state: openEnum(["done", "current", "todo"]),
        at: z.union([InstantSchema, DateSchema, z.null()]),
      }),
    ),
  })
  .openapi("OrderItemInOrder");
export const OrderDetailSchema = z
  .object({
    orderId: IdSchema,
    orderNo: z.string(),
    submittedAt: InstantSchema,
    status: openEnum(DRAMA_ORDER_STATUS.values),
    subStatus: orNull(
      openEnum([
        "qualification_reviewing",
        "qualification_rejected",
        "starting",
        "assigning",
        "plan_confirm",
        "ad_prep",
        "sample_making",
        "sample_confirm",
        "batch_compose",
        "delivering",
        "awaiting_links",
        "verifying",
        "need_fix",
        "expired_unlaunched",
        "in_service",
        "takedown_pending",
        "takedown_overdue",
        "cancel_reviewing",
        "refund_executing",
        "cancelled_before_start",
        "terminated_no_return",
      ]),
    ),
    tab: openEnum(["producing", "to_launch", "live", "ended", "after_sale"]),
    itemCount: positive,
    totalChargePoints: count,
    statusChangedAt: InstantSchema,
    startedAt: InstantSchema.nullable(),
    closedAt: InstantSchema.nullable(),
    entityName: z.string().nullable(),
    storeId: IdSchema,
    storeName: z.string().nullable(),
    planCode: z.string(),
    planName: z.string(),
    discountBp: count,
    isTopModel: z.boolean(),
    surchargeBp: count,
    focus: z.array(DictRefSchema),
    note: z.string().nullable(),
    expectedLaunchDate: DateSchema.nullable(),
    referenceStoreAssetIds: z.array(IdSchema),
    pendingTodo: orNull(OrderTodoSchema),
    items: z.array(OrderItemInOrderSchema),
    deliveryPlan: orNull(
      z.object({
        deliveryPlanId: IdSchema,
        status: openEnum(DELIVERY_PLAN_STATUS.values),
        confirmedVersionNo: positive.nullable(),
        confirmedAt: InstantSchema.nullable(),
        summaryVersionNo: positive.nullable(),
        focus: z.array(DictRefSchema),
        launchMode: z.literal("merchant_self").nullable(),
        placements: z.array(z.object({ slot: placement, durationSec: positive })),
        agreedLaunchDate: DateSchema.nullable(),
      }),
    ),
    pointsEvents: z.array(
      z.object({
        opType: openEnum(["hold", "capture", "release", "refund"]),
        occurredAt: InstantSchema,
        points: count,
        planPoints: count,
        addonPoints: count,
      }),
    ),
    afterSales: z.array(
      z.object({
        cancelRequestId: IdSchema,
        requestNo: z.string(),
        status: openEnum(CANCEL_REQUEST_STATUS.values),
        closeReason: orNull(openEnum(REQUEST_CLOSE_REASON.values)),
        reasonCode: openEnum(CANCEL_REASON_CODE.values),
        submittedAt: InstantSchema,
        executedAt: InstantSchema.nullable(),
        kind: openEnum(CANCEL_REQUEST_KIND.values),
        totalRefundPoints: count,
        lines: z.array(
          z.object({
            orderItemId: IdSchema,
            mode: openEnum(CANCEL_REQUEST_LINE_MODE.values),
            refundPoints: count,
            returnedPoints: count.nullable(),
            convertedPoints: count.nullable(),
            forfeitedPoints: count.nullable(),
          }),
        ),
      }),
    ),
    agreements: z.array(
      z.object({
        agreementKey: z.string(),
        name: z.string(),
        agreementVersionId: IdSchema,
        versionLabel: z.string(),
        consentedAt: InstantSchema,
      }),
    ),
    licenseLetters: z.array(
      z.object({
        licenseLetterId: IdSchema,
        letterNo: z.string(),
        orderItemId: IdSchema,
        platform: openEnum(CHANNEL_PLATFORM.values),
        accountName: z.string(),
        status: openEnum(["pending_effective", "effective"]),
        displayStatus: openEnum(["pending_effective", "effective", "expired"]),
        periodStartDate: DateSchema.nullable(),
        periodEndDate: DateSchema,
      }),
    ),
    actions: z.array(z.string()),
  })
  .openapi("OrderDetail");
export const OrderCreateResultSchema = OrderDetailSchema.extend({ replayed: z.boolean() }).openapi(
  "OrderCreateResult",
);
export type OrderQuoteBody = z.infer<typeof OrderQuoteBodySchema>;
export type OrderCreateBody = z.infer<typeof OrderCreateBodySchema>;
export type OrderQuote = z.infer<typeof OrderQuoteSchema>;
export type OrderDetail = z.infer<typeof OrderDetailSchema>;
export type OrderCreateResult = z.infer<typeof OrderCreateResultSchema>;

// data09：订单项不可变的剧目事实；仅存事实，不存短期签名 URL。
export const DramaSnapshotSchema = z
  .object({
    dramaId: IdSchema,
    title: z.string(),
    totalEpisodes: positive,
    dramaClass: z.enum(["class_1", "class_2", "class_3"]),
    genreCodes: z.array(z.string()),
    permits: z.array(
      z.object({
        platform: z.enum(["all", "douyin", "wechat_channels"]),
        kind: z.enum(["license_no", "approval_no", "program_no"]),
        number: z.string(),
      }),
    ),
    licenseEndDate: DateSchema,
    posterFileId: IdSchema.nullable(),
    allowedPlacements: z.array(placement),
    isAiGenerated: z.boolean(),
  })
  .openapi("DramaSnapshot");
export type DramaSnapshot = z.infer<typeof DramaSnapshotSchema>;
