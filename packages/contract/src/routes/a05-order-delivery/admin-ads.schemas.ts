import { z } from "../../zod.js";
import {
  IdSchema,
  InstantSchema,
  DictRefSchema,
  PageQuerySchema,
  openEnum,
} from "../../common/index.js";
import {
  AD_STATUS,
  AD_VERSION_DECISION,
  AD_REVISION_SOURCE,
  PLACEMENT_SLOT,
  ACTOR_TYPE,
  SAMPLE_CONFIRM_VIEWED_VIA,
  CANCEL_REASON_CODE,
} from "../../enums/index.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { ImageRefSchema } from "../m08-support-misc/image.schemas.js";
import { AdminStoreBriefSchema } from "./public.schemas.js";
import { CancelRequestCardSchema } from "./cancel.schemas.js";
import { OrderReferenceFileSchema } from "./order-read.schemas.js";
import { ActivityItemSchema } from "../a04-content/drama-lifecycle.schemas.js";

const n = z.int().nonnegative(),
  positive = z.int().positive();
const bool = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
const unique = (ids: string[]) => new Set(ids).size === ids.length;
export const AdminAdVersionParamSchema = z.strictObject({ adVersionId: IdSchema });
export const AdEmptyBodySchema = z.strictObject({});
export const AdminAdFiltersSchema = z.strictObject({
  q: z.string().trim().min(1).max(40).optional(),
  editorId: z.union([IdSchema, z.literal("none")]).optional(),
  type: z.enum(["opening", "ending"]).optional(),
  storeId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  overdueOnly: bool.optional(),
  isWaitingQualification: bool.optional(),
  isReturnedStale: bool.optional(),
});
export const AdminAdListQuerySchema = AdminAdFiltersSchema.extend({
  ...PageQuerySchema.shape,
  tab: z
    .enum(["todo", "pending_confirm", "confirmed", "returned", "cancelled", "all"])
    .default("todo"),
  sort: z.enum(["urgency", "-submittedAt", "dueAt"]).default("urgency"),
});
export const AdAssignBodySchema = z.strictObject({ staffId: IdSchema }).openapi("AdAssignBody");
export const AdReturnBodySchema = z
  .strictObject({ reason: z.string().trim().min(1).max(200) })
  .openapi("AdReturnBody");
export const AdSegmentInputSchema = z
  .strictObject({ index: n, fromMs: n, toMs: positive, label: z.string().max(20) })
  .refine((v) => v.fromMs < v.toMs);
export const AdVersionCreateBodySchema = z
  .strictObject({
    fileId: IdSchema,
    segments: z
      .array(AdSegmentInputSchema)
      .max(100)
      .refine((rows) => rows.every((row, index) => row.index === index))
      .optional(),
    adoptedStoreAssetIds: z.array(IdSchema).max(20).refine(unique).optional(),
  })
  .openapi("AdVersionCreateBody");
export const AdVersionPushBodySchema = z
  .strictObject({ includeWecom: z.boolean().default(false) })
  .openapi("AdVersionPushBody");
export const AdminAdRequestChangeBodySchema = z
  .strictObject({
    versionNo: positive,
    note: z.string().trim().min(1).max(200),
    segmentIndex: n.optional(),
    timeStartMs: n.optional(),
    timeEndMs: positive.optional(),
    screenshotFileIds: z.array(IdSchema).max(9).refine(unique).optional(),
  })
  .superRefine((v, ctx) => {
    const timed = v.timeStartMs !== undefined || v.timeEndMs !== undefined;
    if (
      (v.segmentIndex !== undefined && timed) ||
      (timed &&
        (v.timeStartMs === undefined || v.timeEndMs === undefined || v.timeStartMs >= v.timeEndMs))
    )
      ctx.addIssue({ code: "custom", message: "分段与时间范围互斥，起止须完整且递增" });
  })
  .openapi("AdminAdRequestChangeBody");
export const AdminAdVersionViewSchema = z
  .strictObject({
    adVersionId: IdSchema,
    versionNo: positive,
    fileId: IdSchema,
    durationMs: positive,
    width: positive,
    height: positive,
    segments: z.array(AdSegmentInputSchema),
    uploadedBy: StaffBriefSchema,
    uploadedAt: InstantSchema,
    production: z
      .strictObject({
        pipelineState: z.string(),
        gate: z.enum(["pass", "reject"]).nullable(),
        softWarnCount: n,
        aigcState: z.string(),
      })
      .nullable(),
    pushedAt: InstantSchema.nullable(),
    previewChannels: z.array(openEnum(SAMPLE_CONFIRM_VIEWED_VIA.values)),
    offlineSentAt: InstantSchema.nullable(),
    offlineSentBy: StaffBriefSchema.nullable(),
    decision: openEnum(AD_VERSION_DECISION.values).nullable(),
    decidedAt: InstantSchema.nullable(),
    viewedVia: openEnum(SAMPLE_CONFIRM_VIEWED_VIA.values).nullable(),
    viewedAckAt: InstantSchema.nullable(),
    preview: SignedUrlSchema.extend({ posterUrl: z.string().nullable() }).nullable(),
    actions: z.array(z.string()),
    replayed: z.boolean().optional(),
  })
  .openapi("AdminAdVersionView");
export const AdminAdRevisionViewSchema = z
  .strictObject({
    adRevisionId: IdSchema,
    revisionNo: positive,
    onVersionNo: positive,
    source: openEnum(AD_REVISION_SOURCE.values),
    isChargeable: z.boolean(),
    chargePoints: n,
    note: z.string(),
    segmentIndex: n.nullable(),
    timeStartMs: n.nullable(),
    timeEndMs: positive.nullable(),
    screenshots: z.array(ImageRefSchema).nullable(),
    actorType: openEnum(ACTOR_TYPE.values),
    actorName: z.string().nullable(),
    client: z.string().nullable(),
    dueAt: InstantSchema,
    breachedAt: InstantSchema.nullable(),
    fulfilledByVersionNo: positive.nullable(),
    createdAt: InstantSchema,
  })
  .openapi("AdminAdRevisionView");
export const AdTaskCardSchema = z
  .strictObject({
    adId: IdSchema,
    adNo: z.string(),
    store: AdminStoreBriefSchema,
    planName: z.string().nullable(),
    type: openEnum(PLACEMENT_SLOT.values),
    durationSec: positive,
    status: openEnum(AD_STATUS.values),
    isWaitingQualification: z.boolean(),
    editor: StaffBriefSchema.nullable(),
    chargePoints: n,
    isCaptured: z.boolean(),
    submittedAt: InstantSchema,
    dueAt: InstantSchema.nullable(),
    firstDueAt: InstantSchema,
    isFirstBreached: z.boolean(),
    urgency: z.enum(["normal", "due_today", "overdue"]),
    latestVersionNo: n,
    confirmedVersionNo: positive.nullable(),
    revisionCount: n,
    freeRevisionQuota: n,
    openCancelRequest: z
      .strictObject({
        cancelRequestId: IdSchema,
        requestNo: z.string(),
        status: z.string(),
        totalRefundPoints: n,
      })
      .nullable(),
    linkedTicketNos: z.array(z.string()),
    actions: z.array(z.string()),
  })
  .openapi("AdTaskCard");
export const AdTaskDetailSchema = AdTaskCardSchema.extend({
  promoPoints: z.array(DictRefSchema),
  copy: z.string().nullable(),
  remark: z.string().nullable(),
  referenceFiles: z.array(OrderReferenceFileSchema),
  returnedFrom: openEnum(["pending_assign", "producing"]).nullable(),
  returnedAt: InstantSchema.nullable(),
  returnReason: z.string().nullable(),
  resubmitCount: n,
  pricing: z.strictObject({
    unitPricePoints: n,
    discountBp: n,
    chargePoints: n,
    freeRevisionQuota: n,
  }),
  pointHold: z.strictObject({
    pointHoldId: IdSchema,
    status: z.string(),
    heldAt: InstantSchema,
    capturedAt: InstantSchema.nullable(),
  }),
  refunds: z.strictObject({
    refundRequestedPoints: n,
    returnedPoints: n,
    convertedPoints: n,
    forfeitedPoints: n,
  }),
  capturedAt: InstantSchema.nullable(),
  confirmedAt: InstantSchema.nullable(),
  cancelReasonCode: openEnum(CANCEL_REASON_CODE.values).nullable(),
  cancelledAt: InstantSchema.nullable(),
  versions: z.array(AdminAdVersionViewSchema),
  revisions: z.array(AdminAdRevisionViewSchema),
  usages: z.array(
    z.strictObject({
      orderItemId: IdSchema,
      orderNo: z.string(),
      deliveryTicketId: IdSchema.nullable(),
      ticketNo: z.string().nullable(),
      dramaTitle: z.string(),
      slot: openEnum(PLACEMENT_SLOT.values),
      boundVersionNo: positive.nullable(),
      phase: z.string(),
    }),
  ),
  agreement: z.strictObject({
    agreementKey: z.literal("ad_service"),
    versionLabel: z.string(),
    consentedAt: InstantSchema,
    method: z.string(),
  }),
  cancelRequests: z.array(CancelRequestCardSchema),
  serviceTickets: z.array(
    z.strictObject({ serviceTicketId: IdSchema, ticketNo: z.string(), status: z.string() }),
  ),
  recentActivities: z.array(ActivityItemSchema),
  lockVersion: n,
  replayed: z.boolean().optional(),
}).openapi("AdTaskDetail");
export const AdminAdPageSchema = adminPage(AdTaskCardSchema).openapi("AdminAdPage");
export const AdSummarySchema = z
  .strictObject({
    tabs: z.strictObject({ todo: n, pending_confirm: n, confirmed: n, returned: n, cancelled: n }),
    overdueCount: n,
    waitingQualificationCount: n,
  })
  .openapi("AdSummary");
export type AdminAdListQuery = z.infer<typeof AdminAdListQuerySchema>;
export type AdminAdFilters = z.infer<typeof AdminAdFiltersSchema>;
export type AdVersionCreateBody = z.infer<typeof AdVersionCreateBodySchema>;
export type AdVersionPushBody = z.infer<typeof AdVersionPushBodySchema>;
export type AdminAdRequestChangeBody = z.infer<typeof AdminAdRequestChangeBodySchema>;
