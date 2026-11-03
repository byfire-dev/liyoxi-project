// W6-04：a06 §3.28–3.35；响应枚举开放给客户端，写入仍按已知值校验。
import { z } from "../../zod.js";
import {
  DateSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  orNull,
} from "../../common/index.js";
import { openEnum } from "../../common/open-enum.js";
import {
  TAKEDOWN_TASK_BASIS,
  TAKEDOWN_TASK_CHECK_METHOD,
  TAKEDOWN_TASK_MERCHANT_METHOD,
  TAKEDOWN_TASK_STATUS,
  TAKEDOWN_TASK_TRIGGER_KIND,
} from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
import { ApprovalBooleanQuerySchema } from "../a01-system/approvals.schemas.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import {
  AdminChecklistItemViewSchema,
  AdminStoreBriefSchema,
  ChecklistResultInputSchema,
} from "../a05-order-delivery/public.schemas.js";
import { ChannelAccountBriefSchema, csv } from "../m05-delivery-publish/publish.schemas.js";
import { OrderItemBriefSchema, TicketBriefSchema } from "./publish.schemas.js";

const count = z.int().nonnegative();
export const TakedownMethodSchema = zodEnum(TAKEDOWN_TASK_MERCHANT_METHOD);
export const TakedownChecklistCodeSchema = z.enum(["takedown.check", "takedown.absence_check"]);
const publicStatuses = TAKEDOWN_TASK_STATUS.values.filter((value) => value !== "void");
export const TakedownTaskBaseShape = {
  takedownTaskId: IdSchema,
  status: z.enum(publicStatuses).openapi({ "x-open-enum": true }),
  triggerKind: zodEnum(TAKEDOWN_TASK_TRIGGER_KIND).openapi({ "x-open-enum": true }),
  basis: zodEnum(TAKEDOWN_TASK_BASIS).openapi({ "x-open-enum": true }),
  orderNo: z.string(),
  orderItemId: IdSchema,
  dramaTitle: z.string(),
  episodeCount: count,
  usageEndDate: DateSchema,
  dueDate: DateSchema,
  isOverdue: z.boolean(),
  merchantMethod: orNull(zodEnum(TAKEDOWN_TASK_MERCHANT_METHOD).openapi({ "x-open-enum": true })),
  merchantConfirmedAt: orNull(InstantSchema),
  checkedAt: orNull(InstantSchema),
  stillOnlineCount: count,
  escalatedAt: orNull(InstantSchema),
};
export const TakedownTaskRowSchema = z
  .object({
    ...TakedownTaskBaseShape,
    store: AdminStoreBriefSchema,
    account: ChannelAccountBriefSchema,
    overdueDays: orNull(count),
    checkDueAt: orNull(InstantSchema),
    isCheckOverdue: z.boolean(),
    breachNoticeCount: count,
    checkMethod: orNull(zodEnum(TAKEDOWN_TASK_CHECK_METHOD).openapi({ "x-open-enum": true })),
    publisher: orNull(StaffBriefSchema),
    actions: z.array(openEnum(["check", "mark-online", "escalate", "send-breach-notice"])),
  })
  .openapi("TakedownTaskRow");
export const TakedownEventViewSchema = z
  .object({
    at: InstantSchema,
    kind: openEnum([
      "created",
      "auto_reminded",
      "manual_reminded",
      "merchant_confirmed",
      "sample_released",
      "found_online",
      "basis_reopened",
      "escalated",
      "breach_notified",
      "checked",
      "voided",
      "check_due_recalculated",
      "follow_up",
    ]),
    actorType: openEnum(["merchant", "staff", "system"]),
    actorName: z.string().nullable(),
    node: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi("TakedownEventView");
export const TakedownTaskDetailSchema = TakedownTaskRowSchema.extend({
  orderItem: OrderItemBriefSchema,
  ticket: TicketBriefSchema,
  launchTaskId: IdSchema,
  merchantConfirmedByName: z.string().nullable(),
  expectedChecklistCode: TakedownChecklistCodeSchema,
  checklistCode: z.string().nullable(),
  checklistVersionNo: orNull(z.int().positive()),
  results: z.array(AdminChecklistItemViewSchema),
  evidenceFileIds: z.array(IdSchema),
  checkedBy: orNull(StaffBriefSchema),
  isBreachNoticedToday: z.boolean(),
  timeline: z.array(TakedownEventViewSchema),
}).openapi("TakedownTaskDetail");
export const AdminTakedownTaskSummaryQuerySchema = z.object({
  isOverdue: ApprovalBooleanQuerySchema.optional(),
  basis: zodEnum(TAKEDOWN_TASK_BASIS).optional(),
  orderItemId: IdSchema.optional(),
  storeId: IdSchema.optional(),
  dueFrom: DateSchema.optional(),
  dueTo: DateSchema.optional(),
  q: z.string().min(1).max(64).optional(),
});
export const AdminTakedownTaskListQuerySchema = AdminTakedownTaskSummaryQuerySchema.extend({
  ...PageQuerySchema.shape,
  tab: z.enum(["pending", "waiting", "checked"]).default("pending"),
  status: csv(publicStatuses).optional(),
});
export const AdminTakedownTaskSummarySchema = z
  .object({
    pending: count,
    waiting: count,
    checked: count,
    overdue: count,
    dueToday: count,
    checkOverdue: count,
  })
  .openapi("AdminTakedownTaskSummary");
export const TakedownTaskParamSchema = z.object({ takedownTaskId: IdSchema });
export const AdminTakedownTaskPageSchema =
  adminPage(TakedownTaskRowSchema).openapi("AdminTakedownTaskPage");
export const TakedownTaskCheckBodySchema = z
  .strictObject({
    checklistCode: TakedownChecklistCodeSchema,
    ...ChecklistResultInputSchema.shape,
    evidenceFileIds: z
      .array(IdSchema)
      .min(2)
      .max(9)
      .refine((ids) => new Set(ids).size === ids.length, "截图不可重复"),
  })
  .openapi("TakedownTaskCheckBody");
export const TakedownTaskBatchCheckBodySchema = z
  .strictObject({
    items: z
      .array(TakedownTaskCheckBodySchema.extend({ takedownTaskId: IdSchema }))
      .min(1)
      .max(50)
      .refine(
        (items) => new Set(items.map((item) => item.takedownTaskId)).size === items.length,
        "任务不可重复",
      ),
  })
  .openapi("TakedownTaskBatchCheckBody");
export const TakedownTaskBatchCheckResultSchema = z
  .object({
    items: z.array(TakedownTaskRowSchema),
    archivedTicketIds: z.array(IdSchema),
  })
  .openapi("TakedownTaskBatchCheckResult");
export const TakedownTaskNoteBodySchema = z.strictObject({ note: z.string().max(200).optional() });
export const TakedownTaskBreachNoticeBodySchema = z.strictObject({});

export type TakedownTaskRow = z.infer<typeof TakedownTaskRowSchema>;
export type TakedownTaskDetail = z.infer<typeof TakedownTaskDetailSchema>;
export type AdminTakedownTaskListQuery = z.infer<typeof AdminTakedownTaskListQuerySchema>;
export type AdminTakedownTaskSummaryQuery = z.infer<typeof AdminTakedownTaskSummaryQuerySchema>;
export type AdminTakedownTaskSummary = z.infer<typeof AdminTakedownTaskSummarySchema>;
export type TakedownTaskCheckBody = z.infer<typeof TakedownTaskCheckBodySchema>;
export type TakedownTaskBatchCheckBody = z.infer<typeof TakedownTaskBatchCheckBodySchema>;
export type TakedownTaskBatchCheckResult = z.infer<typeof TakedownTaskBatchCheckResultSchema>;
export type TakedownTaskNoteBody = z.infer<typeof TakedownTaskNoteBodySchema>;
