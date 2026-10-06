import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  DictRefSchema,
  PageQuerySchema,
  orNull,
} from "../../common/index.js";
import {
  DELIVERY_TICKET_STEP,
  DELIVERY_TICKET_WAITING_ON,
  DELIVERY_PLAN_STATUS,
  DELIVERY_PLAN_VERSION_DECISION,
  CHANNEL_PLATFORM,
  ORDER_ITEM_PHASE,
} from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import { ApprovalBooleanQuerySchema } from "../a01-system/approvals.schemas.js";
import { ChannelAccountBriefSchema } from "../m05-delivery-publish/publish.schemas.js";
import { AdminStoreBriefSchema } from "./public.schemas.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { ImageRefSchema } from "../m08-support-misc/image.schemas.js";
const n = z.int().min(0),
  text = z.string(),
  date = orNull(DateSchema),
  at = orNull(InstantSchema);
export const PlanParamSchema = z.strictObject({ deliveryPlanId: IdSchema });
export const TicketParamSchema = z.strictObject({ deliveryTicketId: IdSchema });
export const AssignManagerBodySchema = z.strictObject({
  staffId: IdSchema,
  note: text.max(100).optional(),
});
const slots = z.enum(["opening", "ending"]);
const model = z.enum(["standard", "advanced", "top"]);
const priority = z.enum(["standard", "priority", "rush"]);
const unique = <T>(a: T[]) => new Set(a).size === a.length;
export const PlanContentInputSchema = z
  .strictObject({
    focusCodes: z.array(text.min(1)).min(1).refine(unique),
    referenceAssetIds: z.array(IdSchema).refine(unique),
    note: orNull(text.max(200)).optional(),
    launchMode: z.literal("merchant_self"),
    items: z
      .array(
        z.strictObject({
          orderItemId: IdSchema,
          channelAccountIds: z.array(IdSchema).refine(unique),
          placements: z
            .array(z.strictObject({ slot: slots, adId: IdSchema }))
            .refine((a) => unique(a.map((r) => r.slot))),
          agreedLaunchDate: date.optional(),
          expectedDeliveryDate: date.optional(),
        }),
      )
      .min(1)
      .max(50)
      .refine((a) => unique(a.map((r) => r.orderItemId))),
  })
  .openapi("PlanContentInput");
export const PlanContentSchema = z
  .strictObject({
    focusTags: z.array(text),
    referenceAssetIds: z.array(IdSchema),
    note: orNull(text),
    launchMode: z.literal("merchant_self"),
    items: z.array(
      z.strictObject({
        orderItemId: IdSchema,
        accounts: z.array(
          z.strictObject({ channelAccountId: IdSchema, platform: zodEnum(CHANNEL_PLATFORM) }),
        ),
        placements: z.array(z.strictObject({ slot: slots, adId: IdSchema, durationSec: n })),
        agreedLaunchDate: date,
        expectedDeliveryDate: date,
      }),
    ),
  })
  .openapi("PlanContent");
export const PlanDraftReplaceBodySchema = z.strictObject({
  draftLockVersion: n,
  content: PlanContentInputSchema,
});
export const PlanPushBodySchema = z.strictObject({
  draftLockVersion: n,
  changeSummary: text.max(200).optional(),
});
const placement = z.strictObject({
  slot: slots,
  adId: IdSchema,
  adNo: text,
  durationSec: n,
  adStatus: text,
  confirmedVersionNo: orNull(n),
  copy: orNull(text),
});
export const PlanItemContentViewSchema = z
  .strictObject({
    orderItemId: IdSchema,
    dramaTitle: text,
    episodeCount: n,
    allowedPlacements: z.array(slots),
    accounts: z.array(ChannelAccountBriefSchema),
    placements: z.array(placement),
    agreedLaunchDate: date,
    currentAgreedLaunchDate: date,
    expectedDeliveryDate: date,
  })
  .openapi("PlanItemContentView");
export const AdminPlanContentViewSchema = z
  .strictObject({
    focus: z.array(DictRefSchema),
    referenceAssets: z.array(
      z.strictObject({ storeAssetId: IdSchema, type: text, title: orNull(text) }),
    ),
    note: orNull(text),
    launchMode: z.literal("merchant_self"),
    items: z.array(PlanItemContentViewSchema),
  })
  .openapi("AdminPlanContentView");
export const PlanChangeKindsSchema = z.enum([
  "launch_date",
  "account",
  "customization",
  "placement",
  "ad",
  "other",
]);
export const PlanChangeRequestViewSchema = z.strictObject({
  changeRequestId: IdSchema,
  onVersionNo: n,
  kinds: z.array(PlanChangeKindsSchema),
  note: text,
  createdAt: InstantSchema,
  resolvedByVersionNo: orNull(n),
});
export const AdminDeliveryPlanDetailSchema = z
  .strictObject({
    deliveryPlanId: IdSchema,
    orderId: IdSchema,
    orderNo: text,
    store: AdminStoreBriefSchema,
    status: zodEnum(DELIVERY_PLAN_STATUS),
    draft: AdminPlanContentViewSchema,
    draftLockVersion: n,
    currentVersionNo: n,
    confirmedVersionNo: orNull(n),
    pushedAt: at,
    confirmedAt: at,
    staffDueAt: at,
    isOrderInAfterSale: z.boolean(),
    versions: z.array(
      z.strictObject({
        versionNo: n,
        pushedAt: InstantSchema,
        pushedBy: StaffBriefSchema,
        changeSummary: orNull(text),
        decision: orNull(zodEnum(DELIVERY_PLAN_VERSION_DECISION)),
        decidedAt: at,
        decideActorType: orNull(text),
        content: AdminPlanContentViewSchema,
      }),
    ),
    changeRequests: z.array(PlanChangeRequestViewSchema.extend({ createdByName: orNull(text) })),
    itemWindows: z.array(
      z.strictObject({
        orderItemId: IdSchema,
        step: zodEnum(DELIVERY_TICKET_STEP),
        canChangeContent: z.boolean(),
        canChangeAccounts: z.boolean(),
        canReschedule: z.boolean(),
      }),
    ),
    lockVersion: n,
    actions: z.array(text),
  })
  .openapi("AdminDeliveryPlanDetail");
export const AdminDeliveryPlanWriteResultSchema = AdminDeliveryPlanDetailSchema.extend({
  replayed: z.boolean(),
});
export const TicketTabSchema = z.enum([
  "processing",
  ...DELIVERY_TICKET_STEP.values.filter((s) => s !== "archived" && s !== "terminated"),
  "closed",
  "delivered_today",
  "all",
]);
export const TicketFilterSchema = z.object({
  q: text.min(1).max(40).optional(),
  deliveryManagerId: z.union([IdSchema, z.literal("none")]).optional(),
  editorId: IdSchema.optional(),
  publisherId: IdSchema.optional(),
  productionModel: model.optional(),
  platform: zodEnum(CHANNEL_PLATFORM).optional(),
  overdueOnly: ApprovalBooleanQuerySchema.optional(),
  storeId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  orderId: IdSchema.optional(),
  agreedLaunchFrom: DateSchema.optional(),
  agreedLaunchTo: DateSchema.optional(),
  isPaused: ApprovalBooleanQuerySchema.optional(),
  pausedBefore: InstantSchema.optional(),
  isStuck: ApprovalBooleanQuerySchema.optional(),
  todo: z.enum(["plan_push", "sample_qc", "staff_assign"]).optional(),
});
export const TicketListQuerySchema = TicketFilterSchema.extend({
  ...PageQuerySchema.shape,
  tab: TicketTabSchema.default("processing"),
  sort: z.enum(["urgency", "-createdAt", "stepDueAt", "agreedLaunchDate"]).default("urgency"),
});
export const DeliveryTicketCardSchema = z
  .strictObject({
    deliveryTicketId: IdSchema,
    ticketNo: text,
    step: zodEnum(DELIVERY_TICKET_STEP),
    stepEnteredAt: InstantSchema,
    stepDueAt: at,
    waitingOn: zodEnum(DELIVERY_TICKET_WAITING_ON),
    urgency: z.enum(["normal", "due_today", "overdue"]),
    isPaused: z.boolean(),
    pauseReasons: z.array(z.enum(["cancel_review", "plan_amendment"])),
    isStuck: z.boolean(),
    store: AdminStoreBriefSchema,
    order: z.strictObject({ orderId: IdSchema, orderNo: text }),
    orderItemId: IdSchema,
    dramaTitle: text,
    episodeCount: n,
    productionModel: model,
    platforms: z.array(zodEnum(CHANNEL_PLATFORM)),
    agreedLaunchDate: date,
    usageEndDate: DateSchema,
    schedulePriority: priority,
    deliveryManager: orNull(StaffBriefSchema),
    editor: orNull(StaffBriefSchema),
    publisher: orNull(StaffBriefSchema),
    deliveryTargetAt: InstantSchema,
    deliveredAt: at,
    createdAt: InstantSchema,
    actions: z.array(text),
  })
  .openapi("DeliveryTicketCard");
export const DeliveryTicketPageSchema = adminPage(DeliveryTicketCardSchema);
export const DeliveryTicketSummarySchema = z.strictObject({
  tabs: z.record(TicketTabSchema, n),
  header: z.strictObject({ processing: n, overdue: n, dueToday: n }),
});
export const TicketStageViewSchema = z.strictObject({
  step: zodEnum(DELIVERY_TICKET_STEP),
  visitNo: n,
  enteredAt: InstantSchema,
  dueAt: at,
  completedAt: at,
  exitEvent: orNull(text),
  pausedMinutes: n,
  isBreached: z.boolean(),
});
/** a05 §2.2 公共读结构由首个使用者交付，W1-15 复用；本模块只读订单表。 */
export const AdminOrderItemRowSchema = z
  .strictObject({
    orderItemId: IdSchema,
    itemNo: n,
    dramaId: IdSchema,
    dramaTitle: text,
    genres: z.array(DictRefSchema),
    episodeCount: n,
    productionModel: model,
    listPricePoints: n,
    discountBp: n,
    surchargeBp: n,
    chargePoints: n,
    phase: zodEnum(ORDER_ITEM_PHASE),
    phaseChangedAt: InstantSchema,
    capturedAt: at,
    agreedLaunchDate: date,
    usageStartDate: date,
    usageEndDate: DateSchema,
    usageEndSource: z.enum(["license", "early_end", "expired"]),
    liveEpisodeCount: n,
    accounts: z.array(ChannelAccountBriefSchema),
    placements: z.array(
      z.strictObject({
        slot: slots,
        adId: IdSchema,
        adNo: text,
        durationSec: n,
        boundVersionNo: orNull(n),
        pinnedAt: at,
      }),
    ),
    refundRequestedPoints: n,
    returnedPoints: n,
    convertedPoints: n,
    forfeitedPoints: n,
    cancelReasonCode: orNull(text),
    cancelledAt: at,
    ticket: orNull(
      z.strictObject({
        deliveryTicketId: IdSchema,
        ticketNo: text,
        step: zodEnum(DELIVERY_TICKET_STEP),
        isPaused: z.boolean(),
      }),
    ),
    pointHold: z.strictObject({
      pointHoldId: IdSchema,
      status: text,
      heldAt: InstantSchema,
      capturedAt: at,
    }),
  })
  .openapi("AdminOrderItemRow");
export const QcRecordViewSchema = z.strictObject({
  qcRecordId: IdSchema,
  targetType: z.enum(["sample", "episode_output", "delivery_ticket"]),
  targetId: IdSchema,
  checklistCode: z.enum(["qc.sample", "qc.episode", "qc.package"]),
  checklistVersionNo: n,
  verdict: z.enum(["pass", "fail"]),
  rejectReason: orNull(text),
  items: z.array(
    z.strictObject({
      key: text,
      label: text,
      result: z.enum(["pass", "fail", "na"]),
      note: orNull(text),
      merchantVisible: z.boolean(),
    }),
  ),
  inspectedBy: StaffBriefSchema,
  inspectedAt: InstantSchema,
});
/** PR1 只读结构；样片写侧与对应聚合字段由 PR2 交付。 */
export const AdminSampleViewSchema = z.strictObject({
  sampleId: IdSchema,
  deliveryTicketId: IdSchema,
  versionNo: n,
  status: text,
  fileId: IdSchema,
  durationMs: orNull(n),
  adSlots: z.array(z.strictObject({ slot: slots, startMs: n, endMs: n, label: text })),
  adsUsed: z.array(
    z.strictObject({
      slot: slots,
      adId: IdSchema,
      adNo: text,
      versionNo: n,
      isCurrentConfirmed: z.boolean(),
    }),
  ),
  uploadedBy: StaffBriefSchema,
  uploadedAt: InstantSchema,
  production: orNull(
    z.strictObject({
      pipelineState: text,
      gate: orNull(z.enum(["pass", "reject"])),
      softWarnCount: n,
      aigcState: text,
    }),
  ),
  qc: orNull(QcRecordViewSchema),
  pushedBy: orNull(StaffBriefSchema),
  pushedAt: at,
  previewChannels: z.array(text),
  offlineSentAt: at,
  offlineSentBy: orNull(StaffBriefSchema),
  firstViewedAt: at,
  viewedAckAt: at,
  decision: orNull(
    z.strictObject({
      decidedAt: InstantSchema,
      decideClient: text,
      decidedByName: orNull(text),
      onBehalfBy: orNull(StaffBriefSchema),
      viewedVia: orNull(text),
      feedbackKind: orNull(text),
      feedbackNote: orNull(text),
      feedbackTimeMs: orNull(n),
      feedbackImages: orNull(z.array(ImageRefSchema)),
    }),
  ),
  confirmDueRemindAt: at,
  watermark: orNull(
    z.strictObject({ playableAssetId: IdSchema, state: text, fileId: orNull(IdSchema) }),
  ),
  preview: orNull(z.strictObject({ ...SignedUrlSchema.shape, posterUrl: orNull(SignedUrlSchema) })),
  actions: z.array(text),
});
export const DeliveryTicketDetailSchema = DeliveryTicketCardSchema.extend({
  pauses: z.array(
    z.strictObject({
      reason: text,
      refType: text,
      refId: IdSchema,
      actorType: text,
      createdAt: InstantSchema,
    }),
  ),
  pausedAt: at,
  pauseRemainingMin: orNull(n),
  sampleRoundNo: n,
  currentSampleVersionNo: orNull(n),
  milestones: z.strictObject({
    assignedAt: at,
    planConfirmedAt: at,
    adsReadyAt: at,
    sampleFirstPushedAt: at,
    sampleConfirmedAt: at,
    composedAt: at,
    deliveredAt: at,
    linksSubmittedAt: at,
    liveAt: at,
    usageEndedAt: at,
    archivedAt: at,
    terminatedAt: at,
  }),
  stages: z.array(TicketStageViewSchema),
  lockVersion: n,
  orderItem: AdminOrderItemRowSchema,
  order: z.strictObject({
    orderId: IdSchema,
    orderNo: text,
    submittedAt: InstantSchema,
    totalChargePoints: n,
    itemCount: n,
    status: text,
    siblings: z.array(
      z.strictObject({
        deliveryTicketId: IdSchema,
        ticketNo: text,
        dramaTitle: text,
        step: zodEnum(DELIVERY_TICKET_STEP),
      }),
    ),
  }),
  merchant: z.strictObject({
    store: AdminStoreBriefSchema,
    province: orNull(DictRefSchema),
    industry: orNull(DictRefSchema),
    category: orNull(DictRefSchema),
    contactName: orNull(text),
    contactPhoneMask: orNull(text),
    isWecomAdded: z.boolean(),
  }),
  plan: orNull(
    z.strictObject({
      deliveryPlanId: IdSchema,
      status: zodEnum(DELIVERY_PLAN_STATUS),
      currentVersionNo: n,
      confirmedVersionNo: orNull(n),
      pushedAt: at,
      pushedBy: orNull(StaffBriefSchema),
      confirmedAt: at,
      item: orNull(PlanItemContentViewSchema),
    }),
  ),
  ads: z.array(
    z.strictObject({
      slot: slots,
      adId: IdSchema,
      adNo: text,
      type: text,
      durationSec: n,
      copy: orNull(text),
      status: text,
      confirmedVersionNo: orNull(n),
      confirmedAt: at,
      boundVersionNo: orNull(n),
      freeRevisionsLeft: n,
      inUseItemCount: n,
      sameOrderItemCount: n,
      sameOrderTickets: z.array(
        z.strictObject({ deliveryTicketId: IdSchema, ticketNo: text, dramaTitle: text }),
      ),
      dueAt: at,
    }),
  ),
  currentSample: orNull(AdminSampleViewSchema),
  samples: z.array(
    z.strictObject({
      sampleId: IdSchema,
      versionNo: n,
      status: text,
      uploadedAt: InstantSchema,
      pushedAt: at,
    }),
  ),
  episodeProgress: z.strictObject({
    totalEpisodes: n,
    currentPassedCount: n,
    uploadedCount: n,
    rejectedCount: n,
    packageQc: orNull(QcRecordViewSchema),
  }),
  release: orNull(
    z.strictObject({
      deliveryReleaseId: IdSchema,
      releaseNo: text,
      kind: text,
      pushedAt: InstantSchema,
      episodeCount: n,
      totalBytes: text,
      savedEpisodeCount: n,
      grantExpiresAt: at,
    }),
  ),
  openReissue: orNull(z.strictObject({ deliveryReissueId: IdSchema, status: text })),
  openUploadBatches: z.array(
    z.strictObject({
      uploadBatchId: IdSchema,
      state: text,
      scope: text,
      expectedCount: n,
      createdBy: StaffBriefSchema,
      expiresAt: InstantSchema,
    }),
  ),
  publishList: orNull(
    z.strictObject({ publishListId: IdSchema, savedAt: at, isComplete: z.boolean() }),
  ),
  launch: z.strictObject({
    taskCount: n,
    liveCount: n,
    verifyingCount: n,
    needFixCount: n,
    pendingCount: n,
    tasks: z.array(
      z.strictObject({
        launchTaskId: IdSchema,
        channelAccountId: IdSchema,
        platform: zodEnum(CHANNEL_PLATFORM),
        accountName: text,
        reviewStatus: text,
        isLive: z.boolean(),
        currentRoundNo: n,
        currentLaunchSubmissionId: orNull(IdSchema),
      }),
    ),
  }),
  remindScenes: z.array(z.enum(["confirm_plan", "confirm_sample", "golive"])),
}).openapi("DeliveryTicketDetail");
export const DeliveryTicketWriteResultSchema = DeliveryTicketDetailSchema.extend({
  replayed: z.boolean(),
});
export type PlanContent = z.infer<typeof PlanContentSchema>;
export type PlanContentInput = z.infer<typeof PlanContentInputSchema>;
export type PlanDraftReplaceBody = z.infer<typeof PlanDraftReplaceBodySchema>;
export type PlanPushBody = z.infer<typeof PlanPushBodySchema>;
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;
export type TicketFilter = z.infer<typeof TicketFilterSchema>;
