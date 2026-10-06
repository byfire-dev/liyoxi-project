import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  PageQuerySchema,
  orNull,
  openEnum,
} from "../../common/index.js";
import {
  DRAMA_ORDER_STATUS,
  CHANNEL_ACCOUNT_STATUS,
  POINT_HOLD_STATUS,
} from "../../enums/index.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { AdminStoreBriefSchema } from "./public.schemas.js";
import { OrderDetailSchema, OrderItemInOrderSchema } from "../m04-mall-order/order.schemas.js";
const count = z.int().nonnegative();
export const AdminOrderFiltersSchema = z
  .object({
    q: z.string().min(1).max(40).optional(),
    storeId: IdSchema.optional(),
    entityId: IdSchema.optional(),
    deliveryManagerId: z.union([IdSchema, z.literal("none")]).optional(),
    dramaId: IdSchema.optional(),
    submittedFrom: DateSchema.optional(),
    submittedTo: DateSchema.optional(),
    isRejectedStale: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  })
  .refine((v) => !v.submittedFrom || !v.submittedTo || v.submittedFrom <= v.submittedTo, {
    path: ["submittedTo"],
    message: "结束日期须不早于开始日期",
  })
  .openapi("AdminOrderFilters");
export const AdminOrderListQuerySchema = AdminOrderFiltersSchema.safeExtend({
  ...PageQuerySchema.shape,
  tab: z.enum(["all", ...DRAMA_ORDER_STATUS.values]).default("all"),
  sort: z.enum(["-submittedAt", "submittedAt", "-statusChangedAt"]).default("-submittedAt"),
}).openapi("AdminOrderListQuery");
export const AdminOrderCardSchema = OrderDetailSchema.pick({
  orderId: true,
  orderNo: true,
  submittedAt: true,
  planCode: true,
  itemCount: true,
  discountBp: true,
  isTopModel: true,
  surchargeBp: true,
  totalChargePoints: true,
  status: true,
  subStatus: true,
  statusChangedAt: true,
  actions: true,
})
  .extend({
    store: AdminStoreBriefSchema,
    planName: z.string().nullable(),
    firstDramaTitle: z.string(),
    firstEpisodeCount: count,
    platforms: z.array(z.string()),
    productionModels: z.array(z.string()),
    deliveryManager: orNull(StaffBriefSchema),
    openCancelRequest: orNull(
      z.object({
        cancelRequestId: IdSchema,
        requestNo: z.string(),
        status: z.string(),
        totalRefundPoints: count,
      }),
    ),
  })
  .openapi("AdminOrderCard");
export const AdminOrderItemRowSchema = OrderItemInOrderSchema.omit({
  posterUrl: true,
  ticketStep: true,
  timeline: true,
  returnPoints: true,
})
  .extend({
    capturedAt: InstantSchema.nullable(),
    accounts: z.array(
      OrderItemInOrderSchema.shape.accounts.element.extend({
        accountUid: z.string(),
        status: openEnum(CHANNEL_ACCOUNT_STATUS.values),
      }),
    ),
    placements: z.array(
      OrderItemInOrderSchema.shape.placements.element.extend({
        pinnedAt: InstantSchema.nullable(),
      }),
    ),
    refundRequestedPoints: count,
    returnedPoints: count,
    convertedPoints: count,
    forfeitedPoints: count,
    ticket: orNull(
      z.object({
        deliveryTicketId: IdSchema,
        ticketNo: z.string(),
        step: z.string(),
        isPaused: z.boolean(),
      }),
    ),
    pointHold: z.object({
      pointHoldId: IdSchema,
      status: openEnum(POINT_HOLD_STATUS.values),
      heldAt: InstantSchema,
      capturedAt: InstantSchema.nullable(),
    }),
  })
  .openapi("AdminOrderItemRow");
export const OrderReferenceFileSchema = z
  .object({
    fileId: IdSchema,
    source: openEnum(["store_asset", "profile_media"]),
    storeAssetId: IdSchema.nullable(),
    title: z.string().nullable(),
    usability: z.string().nullable(),
    mediaGroup: orNull(openEnum(["door", "interior", "product", "promo"])),
    type: z.string(),
    thumbnail: orNull(SignedUrlSchema),
  })
  .openapi("OrderReferenceFile");
export const OrderCancelRequestCardSchema = z
  .object({
    cancelRequestId: IdSchema,
    requestNo: z.string(),
    kind: z.string(),
    store: AdminStoreBriefSchema,
    target: z.object({
      type: openEnum(["drama_order", "ad", "store"]),
      id: IdSchema,
      no: z.string().nullable(),
      label: z.string(),
    }),
    reasonCode: z.string(),
    lineCount: count,
    totalBasePoints: count,
    totalDeductPoints: count,
    totalRefundPoints: count,
    isFullReturn: z.boolean(),
    status: z.string(),
    closeReason: z.string().nullable(),
    approvalStatus: z.string(),
    submittedAt: InstantSchema,
    requester: orNull(StaffBriefSchema),
    isSystemSubmitted: z.boolean(),
    approvalDueAt: InstantSchema.nullable(),
    decidedAt: InstantSchema.nullable(),
    execDueAt: InstantSchema.nullable(),
    executedAt: InstantSchema.nullable(),
    isOverdue: z.boolean(),
    actions: z.array(z.string()),
  })
  .openapi("OrderCancelRequestCard");
export const AdminOrderDetailSchema = AdminOrderCardSchema.extend({
  startedAt: InstantSchema.nullable(),
  closedAt: InstantSchema.nullable(),
  focus: OrderDetailSchema.shape.focus,
  note: z.string().nullable(),
  expectedLaunchDate: DateSchema.nullable(),
  referenceFiles: z.array(OrderReferenceFileSchema),
  subscriptionTerm: z.object({
    subscriptionTermId: IdSchema,
    startDate: DateSchema,
    endDate: DateSchema,
  }),
  items: z.array(AdminOrderItemRowSchema),
  deliveryPlan: orNull(
    z.object({
      deliveryPlanId: IdSchema,
      status: z.string(),
      currentVersionNo: z.int().nullable(),
      confirmedVersionNo: z.int().nullable(),
      pushedAt: InstantSchema.nullable(),
      confirmedAt: InstantSchema.nullable(),
      launchMode: z.string().nullable(),
    }),
  ),
  pointsBreakdown: z.object({
    listPriceTotalPoints: count,
    discountDeltaPoints: z.int(),
    surchargeDeltaPoints: count,
    totalChargePoints: count,
    planPoints: count,
    addonPoints: count,
  }),
  pointsEvents: OrderDetailSchema.shape.pointsEvents,
  agreements: z.array(
    z.object({
      agreementKey: z.string(),
      title: z.string(),
      versionLabel: z.string(),
      consentedAt: InstantSchema,
      method: z.string(),
    }),
  ),
  licenseLetterCount: count,
  licenseLetters: z.array(
    z.object({
      licenseLetterId: IdSchema,
      orderItemId: IdSchema,
      dramaTitle: z.string(),
      letterNo: z.string(),
      platform: z.string(),
      accountName: z.string(),
      status: z.string(),
      isExpired: z.boolean(),
      periodStart: DateSchema.nullable(),
      periodEnd: DateSchema,
      currentRevision: orNull(
        z.object({
          licenseLetterRevisionId: IdSchema,
          revNo: z.int().positive(),
          renderStatus: z.string(),
          fileId: IdSchema.nullable(),
        }),
      ),
    }),
  ),
  merchant: z.object({
    contactName: z.string().nullable(),
    contactPhoneMask: z.string().nullable(),
    currentPlanName: z.string().nullable(),
    currentTermEndDate: DateSchema.nullable(),
    spendablePoints: count,
    planAvailablePoints: count,
    addonAvailablePoints: count,
    sourceType: z.string(),
  }),
  cancelRequests: z.array(OrderCancelRequestCardSchema),
  lockVersion: count,
}).openapi("AdminOrderDetail");
export const AdminOrderListSchema = adminPage(AdminOrderCardSchema).openapi("AdminOrderList");
export const AdminOrderSummarySchema = z
  .object({
    tabs: z.object({
      all: count,
      pending_start: count,
      producing: count,
      to_launch: count,
      live: count,
      ended: count,
      cancelled: count,
      after_sale: count,
      refunded: count,
    }),
  })
  .openapi("OrderSummary");
export type AdminOrderFilters = z.infer<typeof AdminOrderFiltersSchema>;
export type AdminOrderListQuery = z.infer<typeof AdminOrderListQuerySchema>;
export type AdminOrderCard = z.infer<typeof AdminOrderCardSchema>;
export type AdminOrderDetail = z.infer<typeof AdminOrderDetailSchema>;
