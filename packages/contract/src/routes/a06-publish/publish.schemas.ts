import { z } from "../../zod.js";
import { IdSchema, DateSchema, InstantSchema, DictRefSchema, orNull } from "../../common/index.js";
import {
  CHANNEL_ACCOUNT_STATUS,
  CHANNEL_ACCOUNT_ABNORMAL_SOURCE,
  CHANNEL_ACCOUNT_SUBMISSION_KIND,
  LAUNCH_TASK_REVIEW_STATUS,
  LAUNCH_SUBMISSION_LINK_KIND,
  LAUNCH_SUBMISSION_RESULT,
  ORDER_ITEM_PHASE,
  PRODUCTION_MODEL,
  USAGE_END_SOURCE,
  DELIVERY_TICKET_STEP,
} from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
import { ApprovalDecisionViewSchema, ApprovalItemSchema } from "../a01-system/approvals.schemas.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import {
  AdminStoreBriefSchema,
  AdminChecklistItemViewSchema,
  ChecklistResultInputSchema,
} from "../a05-order-delivery/public.schemas.js";
import { ImageRefSchema } from "../m08-support-misc/image.schemas.js";
import {
  AccountFilledSchema,
  AccountTypeSchema,
  PlatformSchema,
  ChannelAccountBriefSchema,
  EpisodeUrlsSchema,
} from "../m05-delivery-publish/publish.schemas.js";
const count = z.int().min(0);
export const COMPARE_FIELDS = [
  "account_name",
  "account_uid",
  "account_type",
  "cert_subject_name",
  "account_status",
] as const;
export const CompareRowViewSchema = z.strictObject({
  field: z.enum(COMPARE_FIELDS),
  filled: orNull(z.string()),
  recognized: orNull(z.string()),
  match: orNull(z.boolean()),
});
export const CompareInputSchema = z
  .array(
    z.strictObject({
      field: z.enum(COMPARE_FIELDS),
      recognized: orNull(z.string().max(100)),
      match: z.boolean(),
    }),
  )
  .length(5)
  .refine((rows) => new Set(rows.map((r) => r.field)).size === 5);
export const PublishApprovalViewSchema = ApprovalDecisionViewSchema.extend({
  submitter: ApprovalItemSchema.shape.submitter,
  submitClient: orNull(z.enum(["weapp", "portal", "admin"])),
  checklist: orNull(
    z.strictObject({
      code: z.string(),
      versionNo: count,
      result: z.array(AdminChecklistItemViewSchema),
    }),
  ),
  confirmChecks: z.array(z.string()),
}).openapi("PublishApprovalView");
export const ChannelAccountRoundViewSchema = z.strictObject({
  channelAccountSubmissionId: IdSchema,
  roundNo: count,
  kind: zodEnum(CHANNEL_ACCOUNT_SUBMISSION_KIND),
  submittedAt: InstantSchema,
  filled: AccountFilledSchema,
  screenshotCount: count,
  compareRows: orNull(z.array(CompareRowViewSchema)),
  approval: PublishApprovalViewSchema,
});
export const ChannelAccountHistorySchema = z.array(
  z.strictObject({
    at: InstantSchema,
    kind: z.enum([
      "bound",
      "submitted",
      "verified",
      "rejected",
      "resubmitted",
      "abnormal",
      "unbound",
    ]),
    actorType: z.enum(["merchant", "staff", "system"]),
    actorName: orNull(z.string()),
    reasons: z.array(DictRefSchema),
    note: orNull(z.string()),
  }),
);
export const ChannelAccountRowSchema = z
  .strictObject({
    channelAccountId: IdSchema,
    store: AdminStoreBriefSchema,
    platform: PlatformSchema,
    accountName: z.string(),
    accountUid: z.string(),
    status: zodEnum(CHANNEL_ACCOUNT_STATUS),
    accountType: orNull(AccountTypeSchema),
    submittedAccountType: AccountTypeSchema,
    certSubjectName: orNull(z.string()),
    isCertSubjectMatched: orNull(z.boolean()),
    abnormalSource: orNull(zodEnum(CHANNEL_ACCOUNT_ABNORMAL_SOURCE)),
    abnormalReason: orNull(DictRefSchema),
    abnormalNote: orNull(z.string()),
    boundAt: InstantSchema,
    submittedAt: InstantSchema,
    verifiedAt: orNull(InstantSchema),
    verifiedBy: orNull(StaffBriefSchema),
    unboundAt: orNull(InstantSchema),
    latestRound: z.strictObject({
      channelAccountSubmissionId: IdSchema,
      roundNo: count,
      kind: zodEnum(CHANNEL_ACCOUNT_SUBMISSION_KIND),
      submittedAt: InstantSchema,
      approvalId: IdSchema,
      approvalStatus: z.string(),
      dueAt: orNull(InstantSchema),
    }),
    previousDecision: orNull(
      z.strictObject({
        roundNo: count,
        decidedAt: InstantSchema,
        decidedBy: orNull(StaffBriefSchema),
        result: z.enum(["approved", "rejected", "withdrawn"]),
        reasons: z.array(DictRefSchema),
      }),
    ),
    usage: z.strictObject({
      pendingStartCount: count,
      producingCount: count,
      toLaunchCount: count,
      liveCount: count,
    }),
    activeDramas: z
      .array(
        z.strictObject({
          orderItemId: IdSchema,
          dramaTitle: z.string(),
          phase: zodEnum(ORDER_ITEM_PHASE),
          agreedLaunchDate: orNull(DateSchema),
        }),
      )
      .max(5),
    openTakedownTaskCount: count,
    actions: z.array(z.string()),
  })
  .openapi("ChannelAccountRow");
export const ChannelAccountDetailSchema = ChannelAccountRowSchema.extend({
  rounds: z.array(ChannelAccountRoundViewSchema),
  history: ChannelAccountHistorySchema,
}).openapi("ChannelAccountDetail");
export const ChannelAccountSubmissionDetailSchema = z
  .strictObject({
    channelAccountSubmissionId: IdSchema,
    roundNo: count,
    kind: zodEnum(CHANNEL_ACCOUNT_SUBMISSION_KIND),
    isCurrentRound: z.boolean(),
    submittedAt: InstantSchema,
    submittedByName: z.string(),
    account: ChannelAccountRowSchema,
    filled: AccountFilledSchema,
    screenshots: z.array(ImageRefSchema),
    compareRows: z.array(CompareRowViewSchema).length(5),
    approval: PublishApprovalViewSchema,
    otherRounds: z.array(ChannelAccountRoundViewSchema),
    history: ChannelAccountHistorySchema,
    actions: z.array(z.string()),
  })
  .openapi("ChannelAccountSubmissionDetail");
export const ChannelAccountDecisionResultSchema = ChannelAccountSubmissionDetailSchema.extend({
  screenshots: z.array(
    ImageRefSchema.extend({ url: orNull(z.string()), expiresAt: orNull(InstantSchema) }),
  ),
  replayed: z.boolean(),
}).openapi("ChannelAccountDecisionResult");
export const ChannelAccountSubmissionParamSchema = z.object({
  channelAccountSubmissionId: IdSchema,
});
const confirmChecks = z.array(z.string()).max(10).optional();
export const ChannelAccountApproveBodySchema = z.strictObject({
  lockVersion: count,
  confirm: z.strictObject({ roundNo: z.int(), accountUid: z.string() }).optional(),
  confirmChecks,
  accountType: AccountTypeSchema,
  certSubjectName: orNull(z.string().min(1).max(100)).optional(),
  compareRows: CompareInputSchema,
  checklistVersionNo: z.int().min(1).optional(),
  results: ChecklistResultInputSchema.shape.results.optional(),
});
export const ChannelAccountRejectBodySchema = z.strictObject({
  reasonCode: z.string(),
  note: z.string().min(1).max(200),
  compareRows: CompareInputSchema,
});
export const LaunchTaskBriefSchema = z.strictObject({
  launchTaskId: IdSchema,
  platform: PlatformSchema,
  account: ChannelAccountBriefSchema,
  reviewStatus: zodEnum(LAUNCH_TASK_REVIEW_STATUS),
  isLive: z.boolean(),
  currentRoundNo: count,
  verifiedEpisodeCount: count,
  firstLaunchDate: orNull(DateSchema),
  isOverdue: z.boolean(),
  currentSubmissionId: orNull(IdSchema),
  latestPassedSubmissionId: orNull(IdSchema),
});
export const LaunchRoundViewSchema = z.strictObject({
  launchSubmissionId: IdSchema,
  roundNo: count,
  result: zodEnum(LAUNCH_SUBMISSION_RESULT),
  submittedAt: InstantSchema,
  reportedEpisodeCount: count,
  verifiedEpisodeCount: orNull(count),
  actualLaunchDate: DateSchema,
  reopenOfLaunchSubmissionId: orNull(IdSchema),
  decidedAt: orNull(InstantSchema),
  decidedBy: orNull(StaffBriefSchema),
  reasons: z.array(DictRefSchema),
  decisionNote: orNull(z.string()),
});
export const OrderItemBriefSchema = z.strictObject({
  orderItemId: IdSchema,
  orderId: IdSchema,
  orderNo: z.string(),
  orderedAt: InstantSchema,
  dramaTitle: z.string(),
  episodeCount: count,
  productionModel: zodEnum(PRODUCTION_MODEL),
  phase: zodEnum(ORDER_ITEM_PHASE),
  agreedLaunchDate: orNull(DateSchema),
  usageStartDate: orNull(DateSchema),
  usageEndDate: DateSchema,
  usageEndSource: zodEnum(USAGE_END_SOURCE),
  liveEpisodeCount: count,
});
export const TicketBriefSchema = z.strictObject({
  deliveryTicketId: IdSchema,
  ticketNo: z.string(),
  step: zodEnum(DELIVERY_TICKET_STEP),
  isPaused: z.boolean(),
  pauseReasons: z.array(z.enum(["cancel_review", "plan_amendment"])),
  deliveryManager: orNull(StaffBriefSchema),
  publisher: orNull(StaffBriefSchema),
  deliveryTargetAt: InstantSchema,
  deliveredAt: orNull(InstantSchema),
});
export const LaunchSubmissionDetailSchema = z
  .strictObject({
    launchSubmissionId: IdSchema,
    launchTaskId: IdSchema,
    roundNo: count,
    result: zodEnum(LAUNCH_SUBMISSION_RESULT),
    isCurrentRound: z.boolean(),
    reopenOfLaunchSubmissionId: orNull(IdSchema),
    link: z.strictObject({
      linkKind: zodEnum(LAUNCH_SUBMISSION_LINK_KIND),
      collectionUrl: orNull(z.string()),
      episodeUrls: EpisodeUrlsSchema,
      reportedEpisodeCount: count,
      actualLaunchDate: DateSchema,
      submittedAt: InstantSchema,
      submitActorType: z.enum(["merchant", "staff", "system", "partner"]),
      submitClient: orNull(z.enum(["weapp", "portal", "admin"])),
      submittedByName: orNull(z.string()),
    }),
    verifiedEpisodeCount: orNull(count),
    evidenceFileIds: z.array(IdSchema),
    account: ChannelAccountBriefSchema.extend({ accountType: orNull(AccountTypeSchema) }),
    task: LaunchTaskBriefSchema.extend({
      wentLiveAt: orNull(InstantSchema),
      completedAt: orNull(InstantSchema),
    }),
    orderItem: OrderItemBriefSchema,
    ticket: TicketBriefSchema,
    store: AdminStoreBriefSchema,
    licenseLetter: orNull(
      z.strictObject({ licenseLetterId: IdSchema, letterNo: z.string(), status: z.string() }),
    ),
    approval: PublishApprovalViewSchema,
    projectedUsageStartDate: orNull(DateSchema),
    isPartialGoesLive: z.boolean(),
    rounds: z.array(LaunchRoundViewSchema),
    otherTasks: z.array(LaunchTaskBriefSchema),
    revoke: orNull(
      z.strictObject({
        canRevoke: z.boolean(),
        deadlineAt: orNull(InstantSchema),
        blockedReasons: z.array(z.string()),
      }),
    ),
    actions: z.array(z.string()),
  })
  .openapi("LaunchSubmissionDetail");
export const LaunchSubmissionParamSchema = z.object({ launchSubmissionId: IdSchema });
const evidence = z
  .array(IdSchema)
  .max(9)
  .refine((ids) => ids.length === new Set(ids).size)
  .optional();
export const LaunchApproveBodySchema = z.strictObject({
  lockVersion: count,
  confirm: z.strictObject({ roundNo: z.int(), reportedEpisodeCount: z.int() }).optional(),
  confirmChecks,
  verifiedEpisodeCount: z.int(),
  ...ChecklistResultInputSchema.shape,
  evidenceFileIds: evidence,
});
export const LaunchRejectBodySchema = z.strictObject({
  reasonCodes: z
    .array(z.string())
    .min(1)
    .max(6)
    .refine((v) => new Set(v).size === v.length),
  note: z.string().min(1).max(200),
  evidenceFileIds: evidence,
});
export type ChannelAccountApproveBody = z.infer<typeof ChannelAccountApproveBodySchema>;
export type ChannelAccountRejectBody = z.infer<typeof ChannelAccountRejectBodySchema>;
export type LaunchApproveBody = z.infer<typeof LaunchApproveBodySchema>;
export type LaunchRejectBody = z.infer<typeof LaunchRejectBodySchema>;
