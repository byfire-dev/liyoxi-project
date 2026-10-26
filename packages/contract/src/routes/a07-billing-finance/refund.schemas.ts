import { z } from "../../zod.js";
import {
  DateSchema,
  DictRefSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
} from "../../common/index.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import { ApprovalDecisionViewSchema } from "../a01-system/approvals.schemas.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";

export const PlanRefundRuleSchema = z.enum(["window", "qualification_failed", "override"]);
export const CashRefundRuleSchema = z.enum([
  "window",
  "qualification_failed",
  "override",
  "fulfillment_blocked",
  "unapplied_receipt",
]);
export const RefundStatusSchema = z.enum([
  "pending_approval",
  "pending_execution",
  "executing",
  "done",
  "not_executed",
]);
export const RefundParamsSchema = z.object({ refundRequestId: IdSchema });
const paymentTxn = PaymentOrderAdminDetailSchema.shape.paymentTxns.element;
const route = z.enum(["wechat_original", "offline"]);
const sideEffects = z.object({
  revokePoints: z.int().nonnegative(),
  cancelSchedules: z.int().nonnegative(),
  addonWillSuspend: z.int().nonnegative(),
  nextTermWillStartNow: z.boolean(),
});
export const CashRefundQuoteSchema = z
  .object({
    supported: z.boolean(),
    unsupportedReason: z
      .enum([
        "topup_not_refundable",
        "upgrade_refund_source_first",
        "not_fulfilled",
        "not_paid",
        "already_refunded",
        "open_request_exists",
      ])
      .nullable(),
    rules: z.array(
      z.object({
        rule: PlanRefundRuleSchema,
        eligible: z.boolean(),
        reasons: z.array(
          z.enum([
            "outside_window",
            "points_used",
            "term_upgraded",
            "qualification_not_dead",
            "term_not_refundable",
          ]),
        ),
      }),
    ),
    suggestedRule: PlanRefundRuleSchema.nullable(),
    refundableFen: z.int().nonnegative(),
    paymentTxn: paymentTxn.nullable(),
    term: z
      .object({
        subscriptionTermId: IdSchema,
        planName: z.string(),
        status: z.string(),
        startsAt: InstantSchema,
        endsAt: InstantSchema,
        upgraded: z.boolean(),
      })
      .nullable(),
    windowDeadline: InstantSchema.nullable(),
    withinWindow: z.boolean(),
    unused: z.boolean(),
    sideEffects,
    routePreview: route,
    invoice: z.object({ latestStatus: z.string().nullable(), needsRedInvoice: z.boolean() }),
    openRequest: z
      .object({ refundRequestId: IdSchema, requestNo: z.string(), status: RefundStatusSchema })
      .nullable(),
  })
  .openapi("CashRefundQuote");
export const RefundQuoteBodySchema = z.object({ ruleCode: PlanRefundRuleSchema.optional() });
const moneyConfirm = z.object({ requestNo: z.string().min(1), amountFen: z.int().positive() });
const checks = (key: string) =>
  z
    .array(z.string())
    .min(1)
    .max(10)
    .refine((values) => new Set(values).size === values.length, "确认项不得重复")
    .refine((values) => values.includes(key), `请核对${key}`);
export const RefundCreateBodySchema = z
  .object({
    ruleCode: PlanRefundRuleSchema,
    reasonCode: z.string().min(1).max(64),
    note: z.string().trim().max(200).optional(),
    serviceTicketId: IdSchema.optional(),
    confirm: z.object({ orderNo: z.string().min(1), amountFen: z.int().positive() }),
  })
  .refine((v) => v.ruleCode !== "override" || !!v.note, {
    path: ["note"],
    message: "规则外退款须说明",
  });
export const RefundApproveBodySchema = z.object({
  lockVersion: z.int().nonnegative(),
  note: z.string().trim().max(200).optional(),
  confirm: moneyConfirm,
  confirmChecks: checks("rule_amount_checked"),
});
export const RefundRejectBodySchema = z.object({
  reasonCodes: z.array(z.string().min(1).max(64)).max(1).optional(),
  note: z.string().trim().min(1).max(200),
});
export const RefundWithdrawBodySchema = z.object({ note: z.string().trim().max(200).optional() });
export const RefundVoidBodySchema = z.object({
  note: z.string().trim().min(1).max(200),
  confirm: moneyConfirm,
});
export const RefundExecuteBodySchema = z.object({
  confirm: moneyConfirm.extend({ channelTxnNo: z.string().min(1) }),
  confirmChecks: checks("original_txn_checked"),
});
export const RefundOfflineBodySchema = z.object({
  transferDate: DateSchema,
  bankSerialNo: z.string().min(1).max(64),
  payeeName: z.string().trim().min(1).max(100),
  payeeBank: z.string().trim().min(1).max(100),
  payeeAccount: z.string().regex(/^\d{6,40}$/),
  receiptFileId: IdSchema,
  note: z.string().trim().max(200).optional(),
  confirm: moneyConfirm,
  confirmChecks: checks("offline_transfer_checked"),
});
export const RefundRetryBodySchema = z.object({
  confirm: z.object({ requestNo: z.string().min(1), outRefundNo: z.string().min(1) }),
});
export const RefundNotAcceptedBodySchema = RefundRetryBodySchema;
export const RefundFilterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  entityId: IdSchema.optional(),
  storeId: IdSchema.optional(),
  ruleCode: CashRefundRuleSchema.optional(),
  source: z.enum(["customer_service", "exception", "staging_probe"]).optional(),
  overdueOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export const RefundListQuerySchema = RefundFilterSchema.extend({
  ...PageQuerySchema.shape,
  tab: z
    .enum(["pending_approval", "pending_execution", "processed", "all"])
    .default("pending_approval"),
});
export const RefundRequestRowSchema = z.object({
  refundRequestId: IdSchema,
  requestNo: z.string(),
  source: z.enum(["customer_service", "exception", "staging_probe"]),
  entity: PaymentOrderAdminDetailSchema.shape.entity.nullable(),
  paymentOrder: z
    .object({ paymentOrderId: IdSchema, orderNo: z.string(), type: z.string(), title: z.string() })
    .nullable(),
  amountFen: z.int().positive(),
  ruleCode: CashRefundRuleSchema,
  ruleText: z.string(),
  status: RefundStatusSchema,
  closeReason: z.enum(["rejected", "withdrawn", "voided"]).nullable(),
  execRoute: route.nullable(),
  execDueAt: InstantSchema.nullable(),
  isExecOverdue: z.boolean(),
  hasExecError: z.boolean(),
  requester: StaffBriefSchema.nullable(),
  createdAt: InstantSchema,
  decidedAt: InstantSchema.nullable(),
  doneAt: InstantSchema.nullable(),
  closedAt: InstantSchema.nullable(),
});
const execError = z.object({
  at: InstantSchema,
  refundTxnId: IdSchema,
  code: z.string(),
  message: z.string(),
});
export const RefundBreakdownSchema = z.union([
  z.object({
    v: z.literal(1),
    rule: z.literal("override"),
    refundableFen: z.int().positive(),
    sourceTermId: IdSchema,
    cashOnly: z.literal(true),
  }),
  z.object({
    v: z.literal(1),
    rule: PlanRefundRuleSchema,
    refundableFen: z.int().positive(),
    termId: IdSchema,
    termStartsAt: InstantSchema,
    termEndsAt: InstantSchema,
    termStatus: z.string(),
    windowDeadline: InstantSchema.nullable(),
    withinWindow: z.boolean(),
    unused: z.boolean(),
    upgraded: z.boolean(),
    addonAvailable: z.int().nonnegative(),
    sideEffects,
  }),
  z.object({
    v: z.literal(1),
    rule: z.enum(["fulfillment_blocked", "unapplied_receipt"]),
    refundableFen: z.int().positive(),
    paymentExceptionId: IdSchema,
    exceptionNo: z.string(),
    exceptionKind: z.string(),
    unappliedFen: z.int().nonnegative().optional(),
    blockReasonCode: z.string().optional(),
  }),
]);
const recheck = z.object({
  at: InstantSchema,
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  usageOk: z.boolean(),
  upgraded: z.boolean(),
  refundableFen: z.int().nonnegative(),
});
export const RefundTxnViewSchema = z.object({
  refundTxnId: IdSchema,
  outRefundNo: z.string(),
  channel: z.enum(["wechat_jsapi", "offline"]),
  origin: z.enum(["system", "external"]),
  status: z.enum([
    "created",
    "processing",
    "succeeded",
    "closed",
    "abnormal",
    "not_accepted",
    "abandoned",
  ]),
  amountFen: z.int().positive(),
  channelRefundNo: z.string().nullable(),
  submitCount: z.int().nonnegative(),
  lastSubmitAt: InstantSchema.nullable(),
  isRetryHalted: z.boolean(),
  failCode: z.string().nullable(),
  failMessage: z.string().nullable(),
  successAt: InstantSchema.nullable(),
  userReceivedAccount: z.string().nullable(),
  isLateSuccess: z.boolean(),
  offline: z
    .object({
      transferDate: DateSchema,
      payeeName: z.string(),
      payeeBank: z.string(),
      payeeAccountMask: z.string(),
      receiptFileId: IdSchema,
      note: z.string().nullable(),
      registeredBy: StaffBriefSchema.nullable(),
    })
    .nullable(),
});
export const RefundRequestDetailSchema = RefundRequestRowSchema.extend({
  reason: DictRefSchema.nullable(),
  note: z.string().nullable(),
  isOverride: z.boolean(),
  baseAmountFen: z.int().positive(),
  deductAmountFen: z.int().nonnegative(),
  paymentTxn,
  breakdown: RefundBreakdownSchema,
  stageNote: z.string(),
  recheckLog: z.object({ approve: recheck.optional(), execute: recheck.optional() }).nullable(),
  invoice: z.object({
    latest: z
      .object({ invoiceRequestId: IdSchema, requestNo: z.string(), status: z.string() })
      .nullable(),
    needsRedInvoice: z.boolean(),
  }),
  entitlementRevokedAt: InstantSchema.nullable(),
  executedBy: StaffBriefSchema.nullable(),
  isExecutedBySystem: z.boolean().default(false),
  executedAt: InstantSchema.nullable(),
  voidedBy: StaffBriefSchema.nullable(),
  closeNote: z.string().nullable(),
  execError: execError.nullable(),
  refundTxns: z.array(RefundTxnViewSchema),
  allowedRoutes: z.array(route),
  canRetry: z.boolean(),
  canConfirmNotAccepted: z.boolean(),
  paymentException: z
    .object({ paymentExceptionId: IdSchema, exceptionNo: z.string(), kind: z.string() })
    .nullable(),
  relatedServiceTickets: z.array(z.object({ serviceTicketId: IdSchema, ticketNo: z.string() })),
  approval: ApprovalDecisionViewSchema,
  logs: z.array(
    z.object({
      at: InstantSchema,
      actor: z.string(),
      action: z.string(),
      note: z.string().nullable(),
    }),
  ),
  actions: z.array(z.string()),
}).openapi("RefundRequestDetail");
export const RefundRequestPageSchema = adminPage(RefundRequestRowSchema);
export const RefundSummarySchema = z.object({
  tabs: z.object({
    pending_approval: z.int().nonnegative(),
    pending_execution: z.int().nonnegative(),
    processed: z.int().nonnegative(),
  }),
  executingCount: z.int().nonnegative(),
  monthRefunded: z.object({ amountFen: z.string().regex(/^\d+$/), count: z.int().nonnegative() }),
  inProgressCount: z.int().nonnegative(),
  monthRejectedCount: z.int().nonnegative(),
  overdueCount: z.int().nonnegative(),
});
export type CashRefundQuote = z.infer<typeof CashRefundQuoteSchema>;
export type RefundCreateBody = z.infer<typeof RefundCreateBodySchema>;
export type RefundApproveBody = z.infer<typeof RefundApproveBodySchema>;
export type RefundRejectBody = z.infer<typeof RefundRejectBodySchema>;
export type RefundWithdrawBody = z.infer<typeof RefundWithdrawBodySchema>;
export type RefundVoidBody = z.infer<typeof RefundVoidBodySchema>;
export type RefundExecuteBody = z.infer<typeof RefundExecuteBodySchema>;
export type RefundOfflineBody = z.infer<typeof RefundOfflineBodySchema>;
export type RefundRetryBody = z.infer<typeof RefundRetryBodySchema>;
export type RefundNotAcceptedBody = z.infer<typeof RefundNotAcceptedBodySchema>;
export type RefundListQuery = z.infer<typeof RefundListQuerySchema>;
export type RefundFilter = z.infer<typeof RefundFilterSchema>;
export type RefundRequestDetail = z.infer<typeof RefundRequestDetailSchema>;
