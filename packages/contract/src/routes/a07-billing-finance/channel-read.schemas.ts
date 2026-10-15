import { z } from "../../zod.js";
import {
  DateSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  openEnum,
} from "../../common/index.js";
import { adminPage } from "../a01-system/structures.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";

const orderType = z.enum(["plan_new", "plan_renew", "plan_upgrade", "topup"]);
const channel = z.enum(["wechat_jsapi", "bank_transfer"]);
const bool = z.enum(["true", "false"]).transform((value) => value === "true");
export const AdminPaymentOrderSummaryQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  no: z.string().trim().min(1).max(100).optional(),
  entityId: IdSchema.optional(),
  storeId: IdSchema.optional(),
  type: z
    .string()
    .regex(
      /^(?:plan_new|plan_renew|plan_upgrade|topup)(?:,(?:plan_new|plan_renew|plan_upgrade|topup))*$/,
    )
    .optional(),
  channel: channel.optional(),
  source: z.enum(["weapp", "admin"]).optional(),
  hasOpenException: bool.optional(),
  createdFrom: DateSchema.optional(),
  createdTo: DateSchema.optional(),
  sort: z.enum(["-createdAt", "-amountFen"]).default("-createdAt"),
});
export const AdminPaymentOrderListQuerySchema = AdminPaymentOrderSummaryQuerySchema.extend({
  ...PageQuerySchema.shape,
  tab: z
    .enum(["all", "pending_payment", "pending_confirmation", "paid", "cancelled", "refunded"])
    .default("all"),
});
export const PaymentOrderAdminRowSchema = PaymentOrderAdminDetailSchema.pick({
  paymentOrderId: true,
  orderNo: true,
  createdAt: true,
  entity: true,
  store: true,
  type: true,
  title: true,
  contentNote: true,
  amountFen: true,
  paidAmountFen: true,
  refundedAmountFen: true,
  channel: true,
  status: true,
  transferState: true,
  fulfillmentStatus: true,
  statusNote: true,
  hasOpenException: true,
  source: true,
  pendingTransferProofId: true,
  actions: true,
}).openapi("PaymentOrderAdminRow");
export const AdminPaymentOrderPageSchema = adminPage(PaymentOrderAdminRowSchema);
export const AdminPaymentOrderSummarySchema = z.object({
  all: z.int().nonnegative(),
  pending_payment: z.int().nonnegative(),
  pending_confirmation: z.int().nonnegative(),
  paid: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  refunded: z.int().nonnegative(),
});
export const PaymentTransactionSummaryQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  successFrom: DateSchema.optional(),
  successTo: DateSchema.optional(),
  orderType: orderType.optional(),
  channel: channel.optional(),
  reconState: z.enum(["pending", "matched", "diff", "resolved"]).optional(),
  isApplied: bool.optional(),
});
export const PaymentTransactionListQuerySchema = PaymentTransactionSummaryQuerySchema.extend(
  PageQuerySchema.shape,
);
export const PaymentTransactionRowSchema = z
  .object({
    paymentTransactionId: IdSchema,
    channelSuccessAt: InstantSchema,
    channelTxnNo: z.string(),
    channel: openEnum(["wechat_jsapi", "bank_transfer"]),
    paymentOrder: z
      .object({
        paymentOrderId: IdSchema,
        orderNo: z.string(),
        type: PaymentOrderAdminDetailSchema.shape.type,
      })
      .nullable(),
    entity: PaymentOrderAdminDetailSchema.shape.entity.nullable(),
    channelAmountFen: z.int().positive(),
    feeFen: z.int().nullable(),
    refundedFen: z.int().nonnegative(),
    isApplied: z.boolean(),
    reconState: openEnum(["pending", "matched", "diff", "resolved"]),
    payerName: z.string().nullable(),
  })
  .openapi("PaymentTransactionRow");
export const PaymentTransactionPageSchema = adminPage(PaymentTransactionRowSchema);
const money = z.string().regex(/^-?\d+$/);
const receipts = z.object({
  amountFen: money,
  count: z.int().nonnegative(),
  wechatCount: z.int().nonnegative(),
  bankCount: z.int().nonnegative(),
});
export const PaymentTransactionSummarySchema = z.object({
  filtered: z.object({ count: z.int().nonnegative(), channelAmountFen: money }),
  today: receipts,
  month: receipts,
  monthRefund: z.object({ amountFen: money, count: z.int().nonnegative() }),
  openDiff: z.object({
    count: z.int().nonnegative(),
    amountFen: money,
    earliestBillDate: DateSchema.nullable(),
  }),
});
export type AdminPaymentOrderListQuery = z.infer<typeof AdminPaymentOrderListQuerySchema>;
export type AdminPaymentOrderSummaryQuery = z.infer<typeof AdminPaymentOrderSummaryQuerySchema>;
export type PaymentTransactionListQuery = z.infer<typeof PaymentTransactionListQuerySchema>;
export type PaymentTransactionSummaryQuery = z.infer<typeof PaymentTransactionSummaryQuerySchema>;
