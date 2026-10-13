import {
  STORE_LIFECYCLE,
  STORE_ARCHIVE_REASON,
  QUALIFICATION_STATUS,
  SOURCE_TYPE,
  MERCHANT_USER_STATUS,
  USAGE_END_SOURCE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import {
  DateSchema,
  DictRefSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  openEnum,
  orNull,
} from "../../common/index.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import { AssignmentContactViewSchema } from "./assignment-contact.schemas.js";
const count = z.int().min(0);
export const StoreRegionSchema = z.object({
  province: orNull(DictRefSchema),
  city: orNull(DictRefSchema),
  district: orNull(DictRefSchema),
  zone: orNull(DictRefSchema),
});
export const StorePointsSchema = z.object({
  spendablePoints: count,
  planAvailablePoints: count,
  addonAvailablePoints: count,
  heldPoints: count,
  isAddonSuspended: z.boolean(),
});
export const SubscriptionBriefSchema = z
  .object({
    status: openEnum(["none", "active", "expired"]),
    plan: orNull(z.object({ planId: IdSchema, code: z.string(), name: z.string() })),
    months: orNull(count),
    startDate: orNull(DateSchema),
    endDate: orNull(DateSchema),
    hasScheduledTerm: z.boolean(),
    isRefundPending: z.boolean(),
    latestPaymentOrder: orNull(
      z.object({
        paymentOrderId: IdSchema,
        orderNo: z.string(),
        type: z.string(),
        status: z.string(),
        title: z.string(),
        refundedAt: orNull(InstantSchema),
      }),
    ),
  })
  .openapi("SubscriptionBrief");
export const StoreRowSchema = z
  .object({
    storeId: IdSchema,
    name: orNull(z.string()),
    isPrimary: z.boolean(),
    lifecycle: openEnum(STORE_LIFECYCLE.values),
    entity: z.object({
      entityId: IdSchema,
      name: orNull(z.string()),
      activeStoreCount: count,
      primaryStoreName: orNull(z.string()),
    }),
    region: StoreRegionSchema,
    industry: orNull(DictRefSchema),
    category: orNull(DictRefSchema),
    qualificationStatus: openEnum(QUALIFICATION_STATUS.values),
    sourceType: openEnum(SOURCE_TYPE.values),
    deliveryManager: orNull(StaffBriefSchema),
    subscription: SubscriptionBriefSchema,
    points: StorePointsSchema,
    totalPaidFen: orNull(count),
    lastOrderAt: orNull(InstantSchema),
    registeredAt: InstantSchema,
    actions: z.array(z.string()),
  })
  .openapi("StoreRow");
export const StoreHeaderSchema = StoreRowSchema.omit({
  entity: true,
  totalPaidFen: true,
  lastOrderAt: true,
})
  .extend({
    archiveReason: orNull(openEnum(STORE_ARCHIVE_REASON.values)),
    archivedAt: orNull(InstantSchema),
    isChangeInReview: z.boolean(),
    isFinalRejected: z.boolean(),
    entity: z.object({
      entityId: IdSchema,
      name: orNull(z.string()),
      verificationStatus: openEnum(QUALIFICATION_STATUS.values),
      activeStoreCount: count,
    }),
    contact: z.object({ name: orNull(z.string()), phoneMask: orNull(z.string()) }),
    owner: orNull(
      z.object({
        merchantUserId: IdSchema,
        displayName: orNull(z.string()),
        phoneMask: orNull(z.string()),
        status: openEnum(MERCHANT_USER_STATUS.values),
      }),
    ),
    isWecomAdded: z.boolean(),
    managerContact: orNull(
      z.object({
        assignmentHistoryId: IdSchema,
        contactDueAt: InstantSchema,
        isOverdue: z.boolean(),
      }),
    ),
    managerOpenWork: z.object({
      dramaOrderCount: count,
      deliveryTicketProducingCount: count,
      deliveryTicketInServiceCount: count,
      serviceTicketCount: count,
    }),
    pendingPointAdjustment: orNull(
      z.object({
        pointAdjustmentRequestId: IdSchema,
        requestNo: z.string(),
        direction: z.string(),
        lotKind: z.string(),
        adjustPoints: count,
      }),
    ),
    paid: z.object({
      totalPaidFen: count,
      paidOrderCount: count,
      planOrderCount: count,
      topupOrderCount: count,
    }),
    liveDramaCount: count,
    liveSummary: z.object({
      firstLiveDate: orNull(DateSchema),
      latestUsageEndDate: orNull(DateSchema),
      usageEndSource: orNull(openEnum(USAGE_END_SOURCE.values)),
    }),
    deliveringTicketCount: count,
    nearestAgreedLaunchDate: orNull(DateSchema),
  })
  .openapi("StoreHeader");
const csv = (values: readonly string[]) =>
  z
    .string()
    .refine((s) => s.split(",").every((v) => values.includes(v)))
    .transform((s) => [...new Set(s.split(","))]);
const storeFilters = {
  q: z.string().min(1).max(30).optional(),
  regionCode: z.string().optional(),
  industryCode: z.string().optional(),
  categoryCode: z.string().optional(),
  qualificationStatus: csv(["unsubmitted", "pending", "verified", "rejected"]).optional(),
  sourceType: csv(SOURCE_TYPE.values).optional(),
  subscriptionStatus: csv(["none", "active", "expired"]).optional(),
  planId: IdSchema.optional(),
  expiresWithinDays: z.coerce
    .number()
    .pipe(z.union([z.literal(7), z.literal(30)]))
    .optional(),
  deliveryManagerId: IdSchema.optional(),
  isManagerUnassigned: z
    .enum(["true", "false"])
    .transform((s) => s === "true")
    .optional(),
  entityId: IdSchema.optional(),
  lifecycle: z.enum(["active", "archived"]).default("active"),
};
const managerFilter = (v: { deliveryManagerId?: string; isManagerUnassigned?: boolean }) =>
  !(v.deliveryManagerId && v.isManagerUnassigned);
export const StoreListSummaryQuerySchema = z
  .strictObject(storeFilters)
  .refine(managerFilter, "交付经理与未分配互斥");
export const StoreListQuerySchema = z
  .strictObject({
    ...PageQuerySchema.shape,
    ...storeFilters,
    sort: z
      .enum(["-lastOrderAt", "-createdAt", "-totalPaidFen", "-registeredAt", "registeredAt"])
      .default("-lastOrderAt"),
  })
  .refine(managerFilter, "交付经理与未分配互斥");
export const StoreListSummarySchema = z
  .object({
    total: count,
    paidCount: count,
    activePlanCount: count,
    pendingReviewCount: count,
    newThisMonthCount: count,
  })
  .openapi("StoreListSummary");
export type StoreListFilters = z.infer<typeof StoreListSummaryQuerySchema>;
export const AdminStoreListSchema = adminPage(StoreRowSchema);
export const StoreIdParamsSchema = z.object({ storeId: IdSchema });
export const ManagerAssignBodySchema = z.object({
  toStaffId: IdSchema,
  note: z.string().max(200).optional(),
});
export const ManagerAssignResultSchema = z
  .object({
    storeId: IdSchema,
    deliveryManager: StaffBriefSchema,
    synced: z.object({ dramaOrderCount: count, deliveryTicketCount: count }),
  })
  .openapi("ManagerAssignResult");
export type StoreListQuery = z.infer<typeof StoreListQuerySchema>;
export type StoreRow = z.infer<typeof StoreRowSchema>;
export type StoreHeader = z.infer<typeof StoreHeaderSchema>;
export type ManagerAssignBody = z.infer<typeof ManagerAssignBodySchema>;

export const ManagerTransferReasonSchema = z
  .enum(["workload", "merchant_request", "staff_change", "other"])
  .openapi("ManagerTransferReason");
export const ManagerTransferBodySchema = z.strictObject({
  toStaffId: IdSchema,
  reasonCode: ManagerTransferReasonSchema,
  note: z.string().max(200).optional(),
  confirm: z.strictObject({ fromStaffId: IdSchema }),
});
export const ManagerTransferResultSchema = z
  .strictObject({
    storeId: IdSchema,
    deliveryManager: StaffBriefSchema,
    batchId: IdSchema,
    moved: z.strictObject({
      dramaOrderCount: count,
      deliveryTicketCount: count,
      serviceTicketCount: count,
    }),
    contact: AssignmentContactViewSchema,
  })
  .openapi("ManagerTransferResult");
export type ManagerTransferBody = z.infer<typeof ManagerTransferBodySchema>;
export type ManagerTransferResult = z.infer<typeof ManagerTransferResultSchema>;
