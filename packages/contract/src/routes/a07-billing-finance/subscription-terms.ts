// 后台：套餐积分与财务 · subscription-terms（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import {
  DateSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  okResponse,
  errorResponses,
} from "../../common/index.js";
import { adminPage, StaffBriefSchema } from "../a01-system/structures.js";
import { PlanBenefitsSchema } from "../m07-billing/purchase.schemas.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";

const count = z.int().nonnegative();
export const SubscriptionTermParamsSchema = z.object({ subscriptionTermId: IdSchema });
export const SubscriptionTermSummaryQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  managerId: IdSchema.optional(),
  planId: IdSchema.optional(),
});
export const SubscriptionTermListQuerySchema = SubscriptionTermSummaryQuerySchema.extend({
  ...PageQuerySchema.shape,
  tab: z.enum(["expiring", "expired", "renewed"]),
});
export const RenewalReminderNodeSchema = z.object({
  node: z.string(),
  dueDate: DateSchema,
  state: z.enum(["sent", "pending", "skipped"]),
  channels: z.array(
    z.object({ channel: z.string(), status: z.string(), sentAt: InstantSchema.nullable() }),
  ),
});
const renewal = z.object({
  subscriptionTermId: IdSchema,
  paymentOrderId: IdSchema,
  orderNo: z.string(),
  planName: z.string(),
  months: count,
  amountFen: count,
  paidAt: InstantSchema.nullable(),
  newStartDate: DateSchema,
  newEndDate: DateSchema,
  renewalTiming: z.enum(["early", "before_due", "after_expiry"]),
});
export const SubscriptionTermRowSchema = z.object({
  subscriptionTermId: IdSchema,
  entity: PaymentOrderAdminDetailSchema.shape.entity,
  plan: z.object({ planId: IdSchema, name: z.string() }),
  months: count,
  startDate: DateSchema,
  endDate: DateSchema,
  status: z.enum(["scheduled", "active", "ended", "refunded", "cancelled"]),
  remainingDays: z.int().nullable(),
  expiredDays: z.int().nullable(),
  reminders: z.array(RenewalReminderNodeSchema),
  points: z.object({
    planAvailablePoints: count,
    lastExpiredPoints: count.nullable(),
    addonAvailablePoints: count,
    isAddonSuspended: z.boolean(),
  }),
  renewal: renewal.nullable(),
  intent: z.enum(["none", "considering", "confirmed", "declined", "renewed", "extension_pending"]),
  manager: StaffBriefSchema.nullable(),
  remindedToday: z.boolean(),
  actions: z.array(z.enum(["remind", "create-term-extension-request"])),
});
export const SubscriptionTermPageSchema = adminPage(SubscriptionTermRowSchema);
export const SubscriptionTermSummarySchema = z.object({
  expiring: count,
  expired: count,
  renewed: count,
  renewedFen: z.string().regex(/^\d+$/),
  renewedAheadCount: count,
  renewalRate: z.object({
    month: z.string(),
    dueCount: count,
    doneCount: count,
    rateBp: count.nullable(),
    isProvisional: z.boolean(),
  }),
});
export const SubscriptionTermDetailSchema = SubscriptionTermRowSchema.extend({
  endsAt: InstantSchema,
  benefits: PlanBenefitsSchema,
  pointsForecast: z.object({
    planPointsToExpire: count,
    expiresAt: InstantSchema,
    addonWillSuspend: z.boolean(),
  }),
  orderItems: z.object({
    producingCount: count,
    toLaunchCount: count,
    liveCount: count,
    nextLaunchDate: DateSchema.nullable(),
  }),
  nextTerm: z
    .object({
      subscriptionTermId: IdSchema,
      planName: z.string(),
      months: count,
      startDate: DateSchema,
      endDate: DateSchema,
      paymentOrderId: IdSchema,
      orderNo: z.string(),
      amountFen: count,
      paidAt: InstantSchema.nullable(),
    })
    .nullable(),
  extensions: z.array(
    z.object({
      termExtensionRequestId: IdSchema,
      requestNo: z.string(),
      days: count,
      appliedMode: z.string(),
      appliedAt: InstantSchema,
    }),
  ),
  pendingExtension: z
    .object({
      termExtensionRequestId: IdSchema,
      requestNo: z.string(),
      days: count,
      requester: StaffBriefSchema,
    })
    .nullable(),
  latestFollowUp: z
    .object({
      followUpId: IdSchema,
      intent: z.string().nullable(),
      channel: z.string().nullable(),
      content: z.string(),
      createdAt: InstantSchema,
      owner: StaffBriefSchema,
    })
    .nullable(),
});
export const SubscriptionTermReminderSchema = z.object({
  manualReminderLogId: IdSchema,
  bizDate: DateSchema,
  remindedToday: z.literal(true),
});
export type SubscriptionTermListQuery = z.infer<typeof SubscriptionTermListQuerySchema>;
export type SubscriptionTermSummaryQuery = z.infer<typeof SubscriptionTermSummaryQuerySchema>;

export const adminSubscriptionTermList = adminRoute({
  request: { query: SubscriptionTermListQuerySchema },
  responses: { ...okResponse(SubscriptionTermPageSchema), ...errorResponses(400, 401, 403, 404) },
  method: "get",
  path: "/admin/subscription-terms",
  operationId: "admin.subscriptionTerm.list",
  summary:
    "套餐到期跟进：7 天内到期、已过期未续费（30 天内）、本月已续费；搜索、交付经理、版本筛选",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSubscriptionTermSummary = adminRoute({
  request: { query: SubscriptionTermSummaryQuerySchema },
  responses: {
    ...okResponse(SubscriptionTermSummarySchema),
    ...errorResponses(400, 401, 403, 404),
  },
  method: "get",
  path: "/admin/subscription-terms/summary",
  operationId: "admin.subscriptionTerm.summary",
  summary: "套餐到期页 KPI：7 天内到期、已过期未续费、本月续费率",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSubscriptionTermGet = adminRoute({
  request: { params: SubscriptionTermParamsSchema },
  responses: { ...okResponse(SubscriptionTermDetailSchema), ...errorResponses(400, 401, 403, 404) },
  method: "get",
  path: "/admin/subscription-terms/{subscriptionTermId}",
  operationId: "admin.subscriptionTerm.get",
  summary: "到期详情：本期、积分清零与冻结预告、在播短剧、续费信息、提醒时间线、跟进记录",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSubscriptionTermExtensionQuote = adminMeta({
  method: "post",
  path: "/admin/subscription-terms/{subscriptionTermId}/extension-quote",
  operationId: "admin.subscriptionTerm.extensionQuote",
  summary: "补偿延长影响预览：延长后周期、清零时间顺延、已排队周期后移",
  "x-permission": "billing.extension.request",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminSubscriptionTermRemind = adminRoute({
  request: { params: SubscriptionTermParamsSchema },
  responses: {
    ...okResponse(SubscriptionTermReminderSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
  method: "post",
  path: "/admin/subscription-terms/{subscriptionTermId}/remind",
  operationId: "admin.subscriptionTerm.remind",
  summary: "补发续费提醒（订阅消息 + 短信；按“主体 + 日期”每天一次）",
  "x-permission": "order.renewal.remind",
  "x-idempotent": "required",
});
