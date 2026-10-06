import { z } from "../../zod.js";
import {
  IdSchema,
  InstantSchema,
  DictRefSchema,
  PageQuerySchema,
  openEnum,
} from "../../common/index.js";
import { adminPage, StaffBriefSchema } from "../a01-system/structures.js";
import {
  BillingFormulaSchema,
  PaymentOrderDetailSchema,
  PaymentOrderContentViewSchema,
  FulfillmentViewSchema,
} from "../m07-billing/purchase.schemas.js";
const nullableTime = InstantSchema.nullable();
const Entity = z.object({
  entityId: IdSchema,
  name: z.string(),
  primaryStoreId: IdSchema.nullable(),
  primaryStoreName: z.string().nullable(),
  storeCount: z.int().nonnegative(),
  verificationStatus: z.string(),
  managerStaff: StaffBriefSchema.nullable(),
});
const UploadedBy = z.object({ type: openEnum(["merchant", "staff"]), name: z.string().nullable() });
export const TransferProofParamsSchema = z.object({ transferProofId: IdSchema });
export const TransferProofListQuerySchema = PageQuerySchema.extend({
  tab: z.enum(["pending", "processed_today"]).default("pending"),
  q: z.string().max(100).optional(),
});
export const TransferProofSummaryQuerySchema = z.object({ q: z.string().max(100).optional() });
export const TransferProofSummarySchema = z.object({
  pending: z.int().nonnegative(),
  processed_today: z.int().nonnegative(),
  pendingAmountFen: z.string().regex(/^\d+$/),
});
export const TransferProofQueueItemSchema = z.object({
  transferProofId: IdSchema,
  uploadNo: z.int().positive(),
  paymentOrderId: IdSchema,
  orderNo: z.string(),
  orderType: PaymentOrderDetailSchema.shape.type,
  entity: Entity,
  amountFen: z.int().positive(),
  uploadedAt: InstantSchema,
  uploadedBy: UploadedBy,
  dueAt: nullableTime,
  isOverdue: z.boolean(),
  hints: z.array(
    openEnum([
      "uploaded_today",
      "uploaded_earlier",
      "remark_missing_order_no",
      "payer_name_mismatch",
      "amount_mismatch",
      "upgrade_quote_expiring",
      "in_review",
    ]),
  ),
  reviewStatus: openEnum(["pending", "accepted", "rejected", "superseded"]),
  reviewedAt: nullableTime,
  reviewedBy: StaffBriefSchema.nullable(),
});
export const TransferProofPageSchema = adminPage(TransferProofQueueItemSchema);
export const TransferProofDetailSchema = TransferProofQueueItemSchema.extend({
  order: z.object({
    title: z.string(),
    formulaText: z.string().nullable(),
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
    status: PaymentOrderDetailSchema.shape.status,
    transferState: PaymentOrderDetailSchema.shape.transferState,
    createdBy: StaffBriefSchema.nullable(),
  }),
  bizHints: z.array(z.object({ code: z.string(), text: z.string() })),
  fileId: IdSchema,
  fileMime: z.string(),
  ocr: z.object({
    status: z.literal("unavailable"),
    recognized: z.null(),
    warnings: z.array(z.string()),
  }),
  checks: z.array(
    z.object({
      key: z.string(),
      result: z.string(),
      proofValue: z.string().nullable(),
      orderValue: z.string().nullable(),
    }),
  ),
  firstConfirm: z.null(),
  review: z.null(),
  rejectReason: DictRefSchema.nullable(),
  rejectNote: z.string().nullable(),
  otherUploads: z.array(
    z.object({
      transferProofId: IdSchema,
      uploadNo: z.int().positive(),
      reviewStatus: TransferProofQueueItemSchema.shape.reviewStatus,
      uploadedAt: InstantSchema,
    }),
  ),
  secondReviewThresholdFen: z.int().positive().nullable(),
  lockVersion: z.int().nonnegative(),
  actions: z.array(z.string()),
}).openapi("TransferProofDetail");
export const TransferProofConfirmBodySchema = z.object({
  lockVersion: z.int().nonnegative(),
  bankSerialNo: z.string().min(1).max(64),
  payerBankCode: z.string().max(64).optional(),
  confirm: z.object({
    orderNo: z.string(),
    receivedAmountFen: z.int().positive(),
    conflictOrderNos: z.array(z.string()).optional(),
  }),
  confirmChecks: z
    .array(z.string())
    .min(1)
    .max(10)
    .refine((v) => v.includes("bank_statement_checked"), "请核对银行流水"),
});
export const TransferProofConfirmResultSchema = TransferProofDetailSchema.extend({
  outcome: openEnum(["paid", "review_pending"]),
});
export const TransferProofRejectBodySchema = z.object({
  lockVersion: z.int().nonnegative(),
  reasonCode: z.string().min(1).max(64),
  note: z.string().trim().min(1).max(200),
});
const PaymentTxnView = z.object({
  paymentTransactionId: IdSchema,
  attemptNo: z.int().positive(),
  channel: PaymentOrderDetailSchema.shape.channel,
  status: openEnum(["created", "prepaid", "succeeded", "closed"]),
  outTradeNo: z.string(),
  channelTxnNo: z.string().nullable(),
  channelAmountFen: z.int().nullable(),
  feeFen: z.int().nullable(),
  channelSuccessAt: nullableTime,
  isApplied: z.boolean(),
  refundedFen: z.int(),
  reconState: openEnum(["pending", "matched", "diff", "resolved"]),
  payerName: z.string().nullable(),
  confirmedBy: StaffBriefSchema.nullable(),
  reviewedBy: StaffBriefSchema.nullable(),
});
export const PaymentOrderAdminDetailSchema = z
  .object({
    paymentOrderId: IdSchema,
    orderNo: z.string(),
    createdAt: InstantSchema,
    entity: Entity,
    store: z.object({ storeId: IdSchema, name: z.string().nullable() }).nullable(),
    type: PaymentOrderDetailSchema.shape.type,
    title: z.string(),
    contentNote: z.string().nullable(),
    amountFen: z.int(),
    paidAmountFen: z.int(),
    refundedAmountFen: z.int(),
    channel: PaymentOrderDetailSchema.shape.channel,
    status: PaymentOrderDetailSchema.shape.status,
    transferState: PaymentOrderDetailSchema.shape.transferState,
    fulfillmentStatus: PaymentOrderDetailSchema.shape.fulfillmentStatus,
    statusNote: z.string().nullable(),
    hasOpenException: z.boolean(),
    source: openEnum(["weapp", "admin"]),
    pendingTransferProofId: IdSchema.nullable(),
    actions: z.array(z.string()),
    formula: BillingFormulaSchema.nullable(),
    content: PaymentOrderContentViewSchema,
    effectNote: z.string().nullable(),
    expiresAt: InstantSchema,
    paidAt: nullableTime,
    cancelledAt: nullableTime,
    refundedAt: nullableTime,
    fulfilledAt: nullableTime,
    cancelReason: z.string().nullable(),
    fulfillment: FulfillmentViewSchema.partial({ effectiveAt: true })
      .extend({
        effectiveAt: nullableTime,
        status: openEnum(["done", "blocked"]),
        termId: IdSchema.nullable(),
        lotIds: z.array(IdSchema),
        reasonCode: z.string().nullable(),
      })
      .nullable(),
    placedBy: z
      .object({
        merchantUserId: IdSchema,
        displayName: z.string().nullable(),
        phoneMask: z.string().nullable(),
      })
      .nullable(),
    createdBy: StaffBriefSchema.nullable(),
    contractNo: z.string().nullable(),
    clientPlatform: z.string().nullable(),
    clientVersion: z.string().nullable(),
    bankAccount: z
      .object({
        financeConfigRevisionId: IdSchema,
        accountName: z.string(),
        bankName: z.string(),
        accountNoMask: z.string(),
      })
      .nullable(),
    paymentTxns: z.array(PaymentTxnView),
    transferProofs: z.array(
      z.object({
        transferProofId: IdSchema,
        uploadNo: z.int(),
        reviewStatus: TransferProofQueueItemSchema.shape.reviewStatus,
        uploadedAt: InstantSchema,
        reviewedAt: nullableTime,
        uploadedBy: UploadedBy,
      }),
    ),
    refundRequests: z.array(
      z.object({
        refundRequestId: IdSchema,
        requestNo: z.string(),
        ruleCode: z.string(),
        amountFen: z.int(),
        status: z.string(),
        closeReason: z.string().nullable(),
        createdAt: InstantSchema,
      }),
    ),
    invoice: z.object({ state: z.literal("not_eligible"), latest: z.null() }),
    openExceptions: z.array(
      z.object({
        paymentExceptionId: IdSchema,
        exceptionNo: z.string(),
        kind: z.string(),
        status: z.string(),
      }),
    ),
    logs: z.array(
      z.object({
        at: InstantSchema,
        actor: z.string().nullable(),
        action: z.string(),
        note: z.string().nullable(),
      }),
    ),
    lockVersion: z.int().nonnegative(),
  })
  .openapi("PaymentOrderAdminDetail");
export type TransferProofConfirmBody = z.infer<typeof TransferProofConfirmBodySchema>;
export type TransferProofRejectBody = z.infer<typeof TransferProofRejectBodySchema>;
export type TransferProofDetail = z.infer<typeof TransferProofDetailSchema>;
