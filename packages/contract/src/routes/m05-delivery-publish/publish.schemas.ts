import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  DictRefSchema,
  BigIntStringSchema,
  CursorQuerySchema,
  cursorPage,
  orNull,
} from "../../common/index.js";
import {
  CHANNEL_ACCOUNT_STATUS,
  CHANNEL_ACCOUNT_ACCOUNT_TYPE,
  CHANNEL_ACCOUNT_ABNORMAL_SOURCE,
  LAUNCH_TASK_REVIEW_STATUS,
  LAUNCH_TASK_VOID_REASON,
  LAUNCH_SUBMISSION_LINK_KIND,
  LAUNCH_SUBMISSION_RESULT,
  CHANNEL_PLATFORM,
  ORDER_ITEM_PHASE,
  DELIVERY_TICKET_STEP,
} from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
const count = z.int().min(0);
export const csv = (values: readonly string[]) =>
  z
    .string()
    .refine((v) => v.split(",").every((part) => values.includes(part)))
    .transform((v) => [...new Set(v.split(","))]);
export const AccountTypeSchema = zodEnum(CHANNEL_ACCOUNT_ACCOUNT_TYPE);
export const PlatformSchema = zodEnum(CHANNEL_PLATFORM);
export const ChannelAccountBriefSchema = z
  .strictObject({
    channelAccountId: IdSchema,
    platform: PlatformSchema,
    accountName: z.string(),
    accountUid: z.string(),
    status: zodEnum(CHANNEL_ACCOUNT_STATUS),
  })
  .openapi("ChannelAccountBrief");
export const AccountFilledSchema = z.strictObject({
  platform: PlatformSchema,
  accountName: z.string(),
  accountUid: z.string(),
  accountType: AccountTypeSchema,
});
export const ChannelAccountCardSchema = ChannelAccountBriefSchema.extend({
  accountType: orNull(AccountTypeSchema),
  submittedAccountType: AccountTypeSchema,
  certSubjectName: orNull(z.string()),
  abnormalSource: orNull(zodEnum(CHANNEL_ACCOUNT_ABNORMAL_SOURCE)),
  abnormalReason: orNull(DictRefSchema),
  abnormalNote: orNull(z.string()),
  roundNo: count,
  submittedAt: InstantSchema,
  reviewDueAt: orNull(InstantSchema),
  verifiedAt: orNull(InstantSchema),
  usage: z.strictObject({ inProgressCount: count, toLaunchCount: count, liveCount: count }),
  openTakedownTaskCount: count,
  actions: z.array(z.string()),
}).openapi("ChannelAccountCard");
export const ChannelAccountListQuerySchema = CursorQuerySchema.extend({
  status: csv(["pending_verify", "available", "abnormal"]).optional(),
  platform: PlatformSchema.optional(),
});
export const ChannelAccountPageSchema = cursorPage(ChannelAccountCardSchema);
const screenshots = z
  .array(IdSchema)
  .min(1)
  .max(3)
  .refine((ids) => new Set(ids).size === ids.length);
export const ChannelAccountCreateBodySchema = z
  .strictObject({
    platform: PlatformSchema,
    accountName: z.string().min(1).max(30),
    accountUid: z.string().min(1).max(64),
    accountType: AccountTypeSchema,
    screenshotFileIds: screenshots,
  })
  .openapi("ChannelAccountCreateBody");
export const ChannelAccountSubmitBodySchema = z
  .strictObject({ accountType: AccountTypeSchema, screenshotFileIds: screenshots })
  .openapi("ChannelAccountSubmitBody");
export const ChannelAccountParamSchema = z.object({ channelAccountId: IdSchema });
export const EpisodeUrlsSchema = z.array(z.strictObject({ episodeNo: z.int(), url: z.string() }));
export const LaunchTaskSubmitBodySchema = z
  .strictObject({
    linkKind: zodEnum(LAUNCH_SUBMISSION_LINK_KIND),
    collectionUrl: z.string().optional(),
    episodeUrls: EpisodeUrlsSchema.optional(),
    reportedEpisodeCount: z.int(),
    actualLaunchDate: DateSchema,
  })
  .openapi("LaunchTaskSubmitBody");
export const LaunchTaskParamSchema = z.object({ launchTaskId: IdSchema });
export const LaunchFilterQuerySchema = z.object({
  orderId: IdSchema.optional(),
  orderItemId: IdSchema.optional(),
});
export const LaunchTaskListQuerySchema = CursorQuerySchema.extend({
  ...LaunchFilterQuerySchema.shape,
  tab: z.enum(["todo", "done", "all"]).default("todo"),
});
export const LaunchTaskSummarySchema = z.strictObject({ todo: count, done: count, needFix: count });
export const LaunchSubmissionViewSchema = z
  .strictObject({
    roundNo: count,
    linkKind: zodEnum(LAUNCH_SUBMISSION_LINK_KIND),
    collectionUrl: orNull(z.string()),
    episodeUrlCount: count,
    reportedEpisodeCount: count,
    actualLaunchDate: DateSchema,
    submittedAt: InstantSchema,
    result: zodEnum(LAUNCH_SUBMISSION_RESULT),
  })
  .openapi("LaunchSubmissionView");
export const LaunchTaskCardSchema = z
  .strictObject({
    launchTaskId: IdSchema,
    orderItemId: IdSchema,
    platform: PlatformSchema,
    channelAccount: ChannelAccountBriefSchema,
    reviewStatus: zodEnum(LAUNCH_TASK_REVIEW_STATUS),
    isLive: z.boolean(),
    wentLiveAt: orNull(InstantSchema),
    verifiedEpisodeCount: count,
    firstLaunchDate: orNull(DateSchema),
    completedAt: orNull(InstantSchema),
    voidReason: orNull(zodEnum(LAUNCH_TASK_VOID_REASON)),
    latestSubmission: orNull(LaunchSubmissionViewSchema),
    reviewDueAt: orNull(InstantSchema),
    returnInfo: orNull(
      z.strictObject({
        reasons: z.array(DictRefSchema),
        note: orNull(z.string()),
        decidedAt: orNull(InstantSchema),
      }),
    ),
    actions: z.array(z.string()),
  })
  .openapi("LaunchTaskCard");
export const LaunchTaskItemSchema = z
  .strictObject({
    orderItemId: IdSchema,
    dramaTitle: z.string(),
    posterUrl: orNull(SignedUrlSchema),
    episodeCount: count,
    phase: zodEnum(ORDER_ITEM_PHASE),
    liveEpisodeCount: count,
    agreedLaunchDate: orNull(DateSchema),
    usageEndDate: DateSchema,
    ticketStep: zodEnum(DELIVERY_TICKET_STEP),
    isPaused: z.boolean(),
    release: orNull(
      z.strictObject({
        deliveryReleaseId: IdSchema,
        releaseNo: count,
        episodeCount: count,
        totalBytes: BigIntStringSchema,
        grantExpiresAt: orNull(InstantSchema),
        isGrantValid: z.boolean(),
        savedEpisodeCount: count,
        hasChangedEpisodes: z.boolean(),
      }),
    ),
    tasks: z.array(LaunchTaskCardSchema),
  })
  .openapi("LaunchTaskItem");
export const LaunchTaskOrderGroupSchema = z
  .strictObject({
    orderId: IdSchema,
    orderNo: z.string(),
    agreedLaunchDate: orNull(DateSchema),
    daysUntilLaunch: orNull(z.int()),
    items: z.array(LaunchTaskItemSchema),
  })
  .openapi("LaunchTaskOrderGroup");
export const LaunchTaskPageSchema = cursorPage(LaunchTaskOrderGroupSchema);
export const ChecklistItemViewSchema = z
  .strictObject({
    key: z.string(),
    label: z.string(),
    result: z.enum(["pass", "fail", "na"]),
    note: orNull(z.string()),
  })
  .openapi("ChecklistItemView");
export const LaunchTimelineSchema = z.strictObject({
  kind: z.enum([
    "created",
    "submitted",
    "passed",
    "passed_partial",
    "returned",
    "revoked",
    "withdrawn",
    "voided",
  ]),
  at: InstantSchema,
  roundNo: count,
  linkKind: orNull(zodEnum(LAUNCH_SUBMISSION_LINK_KIND)),
  reportedEpisodeCount: orNull(count),
  verifiedEpisodeCount: orNull(count),
  reasons: z.array(DictRefSchema),
  note: orNull(z.string()),
});
export const LaunchTaskDetailSchema = z
  .strictObject({
    task: LaunchTaskCardSchema,
    accountType: orNull(AccountTypeSchema),
    launch: orNull(
      z.strictObject({
        linkKind: zodEnum(LAUNCH_SUBMISSION_LINK_KIND),
        collectionUrl: orNull(z.string()),
        episodeUrls: EpisodeUrlsSchema,
        reportedEpisodeCount: count,
        verifiedEpisodeCount: count,
        actualLaunchDate: DateSchema,
        verifiedAt: orNull(InstantSchema),
        verifiedByName: orNull(z.string()),
      }),
    ),
    verifyChecks: z.array(ChecklistItemViewSchema),
    timeline: z.array(LaunchTimelineSchema),
    patrols: z.array(
      z.strictObject({
        patrolTaskId: IdSchema,
        status: z.enum(["normal", "abnormal", "recovered"]),
        checkedAt: InstantSchema,
        checkedByName: orNull(z.string()),
        results: z.array(ChecklistItemViewSchema),
        abnormalKind: orNull(DictRefSchema),
        note: orNull(z.string()),
        foundAt: orNull(InstantSchema),
        recoveredAt: orNull(InstantSchema),
      }),
    ),
  })
  .openapi("LaunchTaskDetail");
export type ChannelAccountCreateBody = z.infer<typeof ChannelAccountCreateBodySchema>;
export type ChannelAccountSubmitBody = z.infer<typeof ChannelAccountSubmitBodySchema>;
export type LaunchTaskSubmitBody = z.infer<typeof LaunchTaskSubmitBodySchema>;
