// W6-03：a06 §3.1、3.2、3.4、3.20–3.27 与 m05 §3.4。
import { z } from "../../zod.js";
import {
  DateSchema,
  DictRefSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  orNull,
} from "../../common/index.js";
import {
  CHANNEL_ACCOUNT_STATUS,
  LAUNCH_SUBMISSION_LINK_KIND,
  PATROL_TASK_SOURCE,
  PATROL_TASK_STATUS,
} from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
import { ApprovalBooleanQuerySchema } from "../a01-system/approvals.schemas.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import {
  AdminChecklistItemViewSchema,
  AdminStoreBriefSchema,
  ChecklistResultInputSchema,
} from "../a05-order-delivery/public.schemas.js";
import {
  ChannelAccountBriefSchema,
  EpisodeUrlsSchema,
  PlatformSchema,
  csv,
} from "../m05-delivery-publish/publish.schemas.js";
import {
  ChannelAccountRowSchema,
  OrderItemBriefSchema,
  TicketBriefSchema,
} from "./publish.schemas.js";

const count = z.int().nonnegative();
const queryText = z.string().min(1).max(64).optional();
const monday = DateSchema.refine(
  (value) => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1,
  "weekStartDate 须是周一",
);
const evidenceFileIds = z
  .array(IdSchema)
  .min(1)
  .max(9)
  .refine((ids) => new Set(ids).size === ids.length, "截图不可重复");

export const AdminChannelAccountFilterSchema = z.object({
  storeId: IdSchema.optional(),
  platform: PlatformSchema.optional(),
  q: queryText,
});
export const AdminChannelAccountListQuerySchema = AdminChannelAccountFilterSchema.extend({
  ...PageQuerySchema.shape,
  status: csv(CHANNEL_ACCOUNT_STATUS.values).optional(),
});
export const AdminChannelAccountSummaryQuerySchema = AdminChannelAccountFilterSchema;
export const AdminChannelAccountPageSchema = adminPage(ChannelAccountRowSchema);
export const AdminChannelAccountSummarySchema = z
  .strictObject({
    total: count,
    pendingVerify: count,
    available: count,
    abnormal: count,
    unbound: count,
  })
  .openapi("ChannelAccountSummary");
export const AdminChannelAccountMarkAbnormalBodySchema = z
  .strictObject({ reasonCode: z.string().min(1), note: z.string().min(1).max(200) })
  .openapi("ChannelAccountMarkAbnormalBody");
export const ChannelAccountUnbindBodySchema = z.strictObject({});

export const PatrolTaskParamSchema = z.object({ patrolTaskId: IdSchema });
export const PatrolTaskFilterQuerySchema = z.object({
  weekStartDate: monday.optional(),
  openOnly: ApprovalBooleanQuerySchema.optional(),
  source: zodEnum(PATROL_TASK_SOURCE).optional(),
  storeId: IdSchema.optional(),
  q: queryText,
});
export const PatrolTaskListQuerySchema = PatrolTaskFilterQuerySchema.extend({
  ...PageQuerySchema.shape,
  tab: z.enum(["all", "pending", "abnormal", "normal"]).default("all"),
});
export const PatrolTaskSummaryQuerySchema = PatrolTaskFilterQuerySchema;
export const PatrolTaskRowSchema = z
  .strictObject({
    patrolTaskId: IdSchema,
    weekStartDate: DateSchema,
    source: zodEnum(PATROL_TASK_SOURCE),
    status: zodEnum(PATROL_TASK_STATUS),
    store: AdminStoreBriefSchema,
    orderItemId: IdSchema,
    dramaTitle: z.string(),
    episodeCount: count,
    usageEndDate: DateSchema,
    launchTaskId: IdSchema,
    account: ChannelAccountBriefSchema,
    previousPatrol: orNull(
      z.strictObject({
        patrolTaskId: IdSchema,
        status: zodEnum(PATROL_TASK_STATUS),
        checkedAt: InstantSchema,
      }),
    ),
    abnormalKind: orNull(DictRefSchema),
    checkedAt: orNull(InstantSchema),
    foundAt: orNull(InstantSchema),
    recoveredAt: orNull(InstantSchema),
    publisher: orNull(StaffBriefSchema),
  })
  .openapi("PatrolTaskRow");
export const PatrolTaskDetailSchema = PatrolTaskRowSchema.extend({
  orderItem: OrderItemBriefSchema,
  ticket: TicketBriefSchema,
  liveLink: orNull(
    z.strictObject({
      linkKind: zodEnum(LAUNCH_SUBMISSION_LINK_KIND),
      collectionUrl: orNull(z.string()),
      episodeUrls: EpisodeUrlsSchema,
    }),
  ),
  checklistCode: orNull(z.literal("patrol.check")),
  checklistVersionNo: orNull(z.int().positive()),
  results: z.array(AdminChecklistItemViewSchema),
  note: orNull(z.string()),
  // 恢复追加新截图，历史证据数组不受单次上传九张的上限限制。
  evidenceFileIds: z.array(IdSchema).refine((ids) => new Set(ids).size === ids.length),
  checkedBy: orNull(StaffBriefSchema),
  notifiedAt: orNull(InstantSchema),
  remindCount: count,
  lastRemindedAt: orNull(InstantSchema),
  isRemindedToday: z.boolean(),
  followUpDueAt: orNull(InstantSchema),
  history: z
    .array(
      z.strictObject({
        patrolTaskId: IdSchema,
        weekStartDate: DateSchema,
        status: zodEnum(PATROL_TASK_STATUS),
        checkedAt: orNull(InstantSchema),
        abnormalKind: orNull(DictRefSchema),
      }),
    )
    .max(10),
  actions: z.array(z.enum(["mark-normal", "mark-abnormal", "recover", "remind"])),
}).openapi("PatrolTaskDetail");
export const PatrolTaskPageSchema = adminPage(PatrolTaskRowSchema);
export const PatrolSummarySchema = z
  .strictObject({
    weekStartDate: DateSchema,
    weekEndDate: DateSchema,
    batch: orNull(
      z.strictObject({
        patrolBatchId: IdSchema,
        liveTotal: count,
        sampledCount: count,
        generatedAt: orNull(InstantSchema),
      }),
    ),
    all: count,
    pending: count,
    abnormal: count,
    normal: count,
    checked: count,
  })
  .openapi("PatrolSummary");
export const PatrolTaskCreateBodySchema = z
  .strictObject({ launchTaskId: IdSchema, reason: z.string().max(200).optional() })
  .openapi("PatrolTaskCreateBody");
export const PatrolTaskCreateResultSchema = z
  .strictObject({ isNew: z.boolean(), patrolTask: PatrolTaskDetailSchema })
  .openapi("PatrolTaskCreateResult");
export const PatrolTaskMarkNormalBodySchema = z
  .strictObject({ ...ChecklistResultInputSchema.shape, evidenceFileIds })
  .openapi("PatrolTaskMarkNormalBody");
export const PatrolTaskMarkAbnormalBodySchema = z
  .strictObject({
    abnormalKindCode: z.string().min(1),
    note: z.string().min(1).max(200),
    evidenceFileIds,
    checklistVersionNo: ChecklistResultInputSchema.shape.checklistVersionNo.optional(),
    results: ChecklistResultInputSchema.shape.results.optional(),
  })
  .refine(
    (body) => (body.checklistVersionNo === undefined) === (body.results === undefined),
    "清单版本与结论须同时提供",
  )
  .openapi("PatrolTaskMarkAbnormalBody");
export const PatrolTaskRecoverBodySchema = z
  .strictObject({ ...ChecklistResultInputSchema.shape, evidenceFileIds })
  .openapi("PatrolTaskRecoverBody");
export const PatrolTaskRemindBodySchema = z.strictObject({});

export type AdminChannelAccountListQuery = z.infer<typeof AdminChannelAccountListQuerySchema>;
export type AdminChannelAccountSummaryQuery = z.infer<typeof AdminChannelAccountSummaryQuerySchema>;
export type AdminChannelAccountMarkAbnormalBody = z.infer<
  typeof AdminChannelAccountMarkAbnormalBodySchema
>;
export type PatrolTaskListQuery = z.infer<typeof PatrolTaskListQuerySchema>;
export type PatrolTaskSummaryQuery = z.infer<typeof PatrolTaskSummaryQuerySchema>;
export type PatrolTaskCreateBody = z.infer<typeof PatrolTaskCreateBodySchema>;
export type PatrolTaskMarkNormalBody = z.infer<typeof PatrolTaskMarkNormalBodySchema>;
export type PatrolTaskMarkAbnormalBody = z.infer<typeof PatrolTaskMarkAbnormalBodySchema>;
export type PatrolTaskRecoverBody = z.infer<typeof PatrolTaskRecoverBodySchema>;
