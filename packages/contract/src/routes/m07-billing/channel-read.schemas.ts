import { z } from "../../zod.js";
import { CursorQuerySchema, cursorPage } from "../../common/index.js";
import { PaymentOrderDetailSchema } from "./purchase.schemas.js";

const comma = (values: readonly string[]) =>
  z.string().regex(new RegExp(`^(?:${values.join("|")})(?:,(?:${values.join("|")}))*$`));
export const PaymentOrderSummaryQuerySchema = z.object({
  invoiceState: comma(["eligible", "applying", "invoiced", "expired", "not_eligible"]).optional(),
  status: comma([
    "pending_payment",
    "pending_confirmation",
    "paid",
    "cancelled",
    "refunded",
  ]).optional(),
  type: comma(["plan_new", "plan_renew", "plan_upgrade", "topup"]).optional(),
  no: z.string().trim().min(1).max(100).optional(),
});
export const PaymentOrderListQuerySchema = PaymentOrderSummaryQuerySchema.extend(
  CursorQuerySchema.shape,
);
export const PaymentOrderCardSchema = PaymentOrderDetailSchema.pick({
  paymentOrderId: true,
  orderNo: true,
  type: true,
  status: true,
  channel: true,
  transferState: true,
  amountFen: true,
  title: true,
  createdAt: true,
  paidAt: true,
  invoiceItemName: true,
  invoiceState: true,
  activeInvoiceRequest: true,
  actions: true,
}).openapi("PaymentOrderCard");
export const PaymentOrderListSchema = cursorPage(PaymentOrderCardSchema);
export const PaymentOrderSummarySchema = z.object({ total: z.int().nonnegative() });
export type PaymentOrderListQuery = z.infer<typeof PaymentOrderListQuerySchema>;
export type PaymentOrderSummaryQuery = z.infer<typeof PaymentOrderSummaryQuerySchema>;
