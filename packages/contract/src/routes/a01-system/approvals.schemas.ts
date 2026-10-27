// 审批的结构（docs/api/a01-system.md 第 2.10 节；03 分组 第 4 节）。W1-06 的第一个 PR 只交 ApprovalSummary：
// approval.submit 拿它校验各 kind 的处理器生成的摘要。ApprovalItem、ApprovalDetail、ApprovalCounts、
// ApprovalDecisionView 随读侧三条接口在第二个 PR 交，仍放本文件。
import {
  DateSchema,
  DictRefSchema,
  FenSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  PointsSchema,
  orNull,
} from "../../common/index.js";
import { APPROVAL_KIND, APPROVAL_STATUS } from "../../enums/index.js";
import { z } from "../../zod.js";
import { StaffBriefSchema } from "./structures.js";

/** 审批单的大类（approval_request.category）：review 商家提交的审核，approval 员工发起的审批 */
export const APPROVAL_CATEGORIES = ["review", "approval"] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

/** 有执行步的类型（03分组第3.2节）：审批单停在approved，领域执行；不填在途去重键 */
export const APPROVAL_EXECUTION_KINDS = [
  "order_cancel",
  "ad_cancel",
  "qualification_cancel",
  "plan_refund",
  "staging_pay_refund",
] as const;
export type ApprovalExecutionKind = (typeof APPROVAL_EXECUTION_KINDS)[number];

/** 摘要里的一行键值：已脱敏的展示文本，不放证照号、银行账号、凭证图片等明文 */
export const ApprovalSummaryLineSchema = z.strictObject({
  label: z.string().min(1).max(20),
  value: z.string().max(200),
});

/**
 * approval_request.summary_snapshot：提交时由该 kind 登记的处理器生成，之后不变（03 分组 第 4 节）。
 * 各 kind 的 lines 写什么由登记它的接口文档定；这里是全部 kind 共有的形状，登记方可以另给更窄的 schema。
 * amountFen、points 只作展示与排序，真相在领域表；domain 是一对一领域行的最终表名与 id。
 */
export const ApprovalSummarySchema = z.strictObject({
  /** 队列行标题：库的 CHECK 要求必有 */
  title: z.string().min(1).max(120),
  lines: z.array(ApprovalSummaryLineSchema).max(20).optional(),
  amountFen: FenSchema.optional(),
  points: PointsSchema.optional(),
  domain: z.strictObject({ type: z.string().regex(/^[a-z][a-z0-9_]*$/), id: IdSchema }).optional(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

/** C45：多值查询字段按逗号分隔；布尔值只接受 true / false */
const csv = (values: readonly string[]) =>
  z
    .string()
    .refine(
      (value) => value.split(",").every((part) => values.includes(part)),
      "查询值不在可选范围内",
    )
    .transform((value) => [...new Set(value.split(","))]);
export const ApprovalBooleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
export const ApprovalFilterSchema = z.object({
  kind: csv(APPROVAL_KIND.values).optional(),
  storeId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  q: z.string().min(1).max(30).optional(),
  overdue: ApprovalBooleanQuerySchema.optional(),
  submittedFrom: DateSchema.optional(),
  submittedTo: DateSchema.optional(),
});
export const ApprovalListQuerySchema = ApprovalFilterSchema.extend({
  ...PageQuerySchema.shape,
  tab: z.enum(["todo", "submitted", "done_today", "all"]).default("todo"),
  status: csv(APPROVAL_STATUS.values).optional(),
  sort: z.enum(["due", "-submittedAt", "-decidedAt"]).optional(),
});
export type ApprovalFilter = z.infer<typeof ApprovalFilterSchema>;
export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>;
export const ApprovalActionsSchema = z.array(
  z.enum(["approve", "reject", "withdraw", "approve-review", "reject-review"]),
);
export const ApprovalItemSchema = z
  .object({
    approvalId: IdSchema,
    requestNo: orNull(z.string()),
    kind: z.enum(APPROVAL_KIND.values),
    category: z.enum(APPROVAL_CATEGORIES),
    status: z.enum(APPROVAL_STATUS.values),
    roundNo: z.int().min(1),
    subjectType: z.string(),
    subjectId: IdSchema,
    entityId: orNull(IdSchema),
    storeId: orNull(IdSchema),
    deliveryTicketId: orNull(IdSchema),
    summary: ApprovalSummarySchema,
    domain: z.object({ type: z.string(), id: IdSchema }),
    badges: z.array(z.enum(["check_mismatch", "final_rejected", "overdue"])),
    submitter: z.object({
      actorType: z.enum(["staff", "merchant", "system", "partner"]),
      actorId: orNull(IdSchema),
      label: z.string(),
    }),
    requester: orNull(StaffBriefSchema),
    handler: orNull(StaffBriefSchema),
    submittedAt: InstantSchema,
    dueAt: orNull(InstantSchema),
    decidedBy: orNull(StaffBriefSchema),
    isDecidedBySystem: z.boolean(),
    decidedAt: orNull(InstantSchema),
    decisionNote: orNull(z.string()),
    reasons: z.array(DictRefSchema),
    lockVersion: z.int().min(0),
    actions: ApprovalActionsSchema,
  })
  .openapi("ApprovalItem");
export type ApprovalItem = z.infer<typeof ApprovalItemSchema>;
export const ApprovalDecisionViewSchema = ApprovalItemSchema.pick({
  approvalId: true,
  kind: true,
  status: true,
  roundNo: true,
  submittedAt: true,
  dueAt: true,
  badges: true,
  requester: true,
  decidedBy: true,
  isDecidedBySystem: true,
  decidedAt: true,
  decisionNote: true,
  reasons: true,
  lockVersion: true,
  actions: true,
}).openapi("ApprovalDecisionView");
export type ApprovalDecisionView = z.infer<typeof ApprovalDecisionViewSchema>;
export const ApprovalDetailSchema = ApprovalItemSchema.extend({
  checklist: orNull(
    z.object({
      code: z.string(),
      versionNo: z.int(),
      result: z.array(
        z.object({
          key: z.string(),
          result: z.enum(["pass", "fail", "na"]),
          note: z.string().optional(),
        }),
      ),
    }),
  ),
  confirmChecks: z.array(z.string()),
  sla: orNull(
    z.object({
      policy: z.string(),
      amount: z.number(),
      unit: z.enum([
        "work_minutes",
        "work_days",
        "natural_hours",
        "natural_days",
        "same_day_cutoff",
      ]),
      calendarVersion: z.int(),
      computedAt: InstantSchema,
    }),
  ),
  timeline: z.array(
    z.object({
      fromState: orNull(z.string()),
      toState: z.string(),
      event: z.string(),
      actorType: z.string(),
      actorLabel: z.string(),
      occurredAt: InstantSchema,
      reasonCode: orNull(z.string()),
      note: orNull(z.string()),
      elapsedWorkMin: orNull(z.int()),
    }),
  ),
  operations: z.object({
    get: orNull(z.string()),
    approve: orNull(z.string()),
    reject: orNull(z.string()),
    withdraw: orNull(z.string()),
  }),
}).openapi("ApprovalDetail");
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;
const Count = z.int().min(0);
export const ApprovalCountsSchema = z
  .object({
    items: z.array(
      z.object({
        kind: z.enum(APPROVAL_KIND.values),
        todo: Count,
        submitted: Count,
        doneToday: Count,
        all: Count,
        byStatus: z.object({ pending: Count, approved: Count, rejected: Count, withdrawn: Count }),
        overdue: Count,
        approvedThisMonth: Count,
        rejectedThisMonth: Count,
      }),
    ),
    total: z.object({ todo: Count, overdue: Count }),
    pointsAdjustMonth: orNull(
      z.object({ increasePoints: PointsSchema, decreasePoints: PointsSchema }),
    ),
  })
  .openapi("ApprovalCounts");
export type ApprovalCounts = z.infer<typeof ApprovalCountsSchema>;
