import { z } from "../../zod.js";
import { DateSchema, IdSchema, InstantSchema, PageQuerySchema } from "../../common/index.js";
import {
  PAYMENT_EXCEPTION_DETECTED_BY,
  PAYMENT_EXCEPTION_KIND,
  PAYMENT_EXCEPTION_RESOLUTION,
  PAYMENT_EXCEPTION_STATUS,
} from "../../enums/index.js";
import { adminPage, StaffBriefSchema } from "../a01-system/structures.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";
import { RefundTxnViewSchema } from "./refund.schemas.js";

export const PaymentExceptionKindSchema = z.enum(PAYMENT_EXCEPTION_KIND.values);
export const PaymentResolutionSchema = z
  .enum(PAYMENT_EXCEPTION_RESOLUTION.values)
  .exclude(["none"]);
export type PaymentExceptionKindCode = z.infer<typeof PaymentExceptionKindSchema>;
export type PaymentResolutionCode = z.infer<typeof PaymentResolutionSchema>;
export const PaymentExceptionParamsSchema = z.object({ paymentExceptionId: IdSchema });
export const PaymentExceptionListQuerySchema = PageQuerySchema.extend({
  tab: z.enum(["open", "resolving", "resolved", "all"]).default("open"),
  kind: z
    .preprocess(
      (v) => (typeof v === "string" ? v.split(",") : v),
      z.array(PaymentExceptionKindSchema).min(1).max(14),
    )
    .optional(),
  billDateFrom: DateSchema.optional(),
  billDateTo: DateSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
}).refine((v) => !v.billDateFrom || !v.billDateTo || v.billDateFrom <= v.billDateTo, {
  path: ["billDateTo"],
  message: "结束日不得早于开始日",
});
const orderRef = z.object({
  paymentOrderId: IdSchema,
  orderNo: z.string(),
  type: z.string(),
  title: z.string(),
});
export const PaymentExceptionRowSchema = z.object({
  paymentExceptionId: IdSchema,
  exceptionNo: z.string(),
  kind: PaymentExceptionKindSchema,
  detectedBy: z.enum(PAYMENT_EXCEPTION_DETECTED_BY.values),
  billDate: DateSchema,
  entity: PaymentOrderAdminDetailSchema.shape.entity.nullable(),
  paymentOrder: orderRef.nullable(),
  channelTxnNo: z.string().nullable(),
  amountFen: z.int().nonnegative(),
  causeText: z.string().nullable(),
  status: z.enum(PAYMENT_EXCEPTION_STATUS.values),
  resolution: z.enum(PAYMENT_EXCEPTION_RESOLUTION.values),
  createdAt: InstantSchema,
  resolvedAt: InstantSchema.nullable(),
  isOverdue: z.boolean(),
});
const fact = z.object({
  outTradeNo: z.string().optional(),
  transactionId: z.string().optional(),
  outRefundNo: z.string().optional(),
  refundId: z.string().optional(),
  amountFen: z.int().nonnegative().optional(),
  state: z.string().optional(),
  occurredAt: InstantSchema.optional(),
  text: z.string().optional(),
});
export const PaymentExceptionDetailSchema = PaymentExceptionRowSchema.extend({
  billFact: fact.nullable(),
  platformFact: fact.nullable(),
  paymentTxn: PaymentOrderAdminDetailSchema.shape.paymentTxns.element.nullable(),
  refundTxn: RefundTxnViewSchema.nullable(),
  wxBillLine: z
    .object({
      wxBillLineId: IdSchema,
      lineNo: z.int().positive(),
      lineKind: z.string(),
      tradedAt: InstantSchema,
      outTradeNo: z.string(),
      outRefundNo: z.string().nullable(),
      orderAmountFen: z.int(),
      refundAmountFen: z.int().nullable(),
      matchState: z.string(),
    })
    .nullable(),
  allowedResolutions: z.array(PaymentResolutionSchema),
  linkCandidates: z.array(
    z.object({
      paymentOrderId: IdSchema,
      orderNo: z.string(),
      entity: PaymentOrderAdminDetailSchema.shape.entity,
      amountFen: z.int().positive(),
      status: z.string(),
      createdAt: InstantSchema,
    }),
  ),
  hints: z.array(z.object({ code: z.string(), text: z.string() })),
  resolutionNote: z.string().nullable(),
  resolvedBy: StaffBriefSchema.nullable(),
  refundRequest: z
    .object({ refundRequestId: IdSchema, requestNo: z.string(), status: z.string() })
    .nullable(),
  lockVersion: z.int().nonnegative(),
  actions: z.array(z.literal("resolve")),
}).openapi("PaymentExceptionDetail");
export const PaymentExceptionPageSchema = adminPage(PaymentExceptionRowSchema);
export const PaymentExceptionCreateBodySchema = z.object({
  receivedAt: InstantSchema,
  amountFen: z.int().positive(),
  payerName: z.string().trim().min(1).max(100),
  bankSerialNo: z.string().trim().min(1).max(64),
  payerBankCode: z.string().min(1).max(64).optional(),
  note: z.string().trim().min(1).max(200),
  confirm: z.object({ amountFen: z.int().positive(), bankSerialNo: z.string().min(1) }),
});
const offlineReturn = z.object({
  transferDate: DateSchema,
  bankSerialNo: z.string().trim().min(1).max(64),
  payeeName: z.string().trim().min(1).max(100),
  payeeBank: z.string().trim().min(1).max(100),
  payeeAccount: z.string().regex(/^\d{6,40}$/),
  receiptFileId: IdSchema,
});
export const PaymentExceptionResolveBodySchema = z
  .object({
    lockVersion: z.int().nonnegative(),
    resolution: PaymentResolutionSchema,
    note: z.string().trim().min(1).max(200),
    linkPaymentOrderId: IdSchema.optional(),
    offlineReturn: offlineReturn.optional(),
    confirm: z.object({ exceptionNo: z.string().min(1), amountFen: z.int().nonnegative() }),
  })
  .superRefine((v, ctx) => {
    if (v.resolution === "link_order" && !v.linkPaymentOrderId)
      ctx.addIssue({ code: "custom", path: ["linkPaymentOrderId"], message: "请选择关联付款单" });
    if (v.resolution === "offline_return" && !v.offlineReturn)
      ctx.addIssue({ code: "custom", path: ["offlineReturn"], message: "请填写线下退回凭据" });
  });
export const PaymentExceptionResolveResultSchema = PaymentExceptionDetailSchema.extend({
  outcome: z.enum(["resolved", "refund_requested", "still_blocked"]),
});
export type PaymentExceptionCreateBody = z.infer<typeof PaymentExceptionCreateBodySchema>;
export type PaymentExceptionResolveBody = z.infer<typeof PaymentExceptionResolveBodySchema>;
export type PaymentExceptionListQuery = z.infer<typeof PaymentExceptionListQuerySchema>;
