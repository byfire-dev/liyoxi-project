import { z } from "../../zod.js";
import { IdSchema, InstantSchema, PageQuerySchema, orNull } from "../../common/index.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import {
  InvoiceDocViewSchema,
  InvoiceRejectSchema,
  InvoiceStatusSchema,
  InvoiceTypeSchema,
  InvoiceMediumSchema,
} from "../m07-billing/invoices.schemas.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";
export const AdminInvoiceFilterSchema = z.object({
  q: z.string().max(100).optional(),
  invoiceType: InvoiceTypeSchema.optional(),
  medium: InvoiceMediumSchema.optional(),
});
export const AdminInvoiceListQuerySchema = AdminInvoiceFilterSchema.extend({
  ...PageQuerySchema.shape,
  tab: z.enum(["pending", "red_pending", "processed"]).default("pending"),
});
export const InvoiceRequestAdminRowSchema = z.object({
  invoiceRequestId: IdSchema,
  requestNo: z.string(),
  entity: PaymentOrderAdminDetailSchema.shape.entity,
  paymentOrder: z.object({
    paymentOrderId: IdSchema,
    orderNo: z.string(),
    type: z.string(),
    title: z.string(),
  }),
  amountFen: z.int().positive(),
  invoiceType: InvoiceTypeSchema,
  medium: InvoiceMediumSchema,
  needsMail: z.boolean(),
  status: InvoiceStatusSchema,
  appliedAt: InstantSchema,
  dueAt: InstantSchema.nullable(),
  isHeldByRefund: z.boolean(),
  resultNote: z.string().nullable(),
});
export const InvoiceRequestAdminDetailSchema = InvoiceRequestAdminRowSchema.extend({
  title: z.string(),
  taxNoMask: z.string(),
  addrTelMask: z.string().nullable(),
  bankAccountMask: z.string().nullable(),
  recvEmailMask: z.string().nullable(),
  mailToMask: z.string().nullable(),
  itemName: z.string(),
  orderPaidAt: InstantSchema,
  orderChannel: PaymentOrderAdminDetailSchema.shape.channel,
  prechecks: z.array(z.object({ key: z.string(), passed: z.boolean() })),
  heldByRefund: z.object({ refundRequestId: IdSchema, requestNo: z.string() }).nullable(),
  docs: z.array(
    InvoiceDocViewSchema.extend({
      invoiceDocId: IdSchema,
      fileId: IdSchema.nullable(),
      issuedBy: orNull(StaffBriefSchema),
      emailSentAt: InstantSchema.nullable(),
      redReason: z.string().nullable(),
    }),
  ),
  reject: orNull(InvoiceRejectSchema.extend({ rejectedBy: orNull(StaffBriefSchema) })),
  lockVersion: z.int().nonnegative(),
  actions: z.array(z.string()),
}).openapi("InvoiceRequestAdminDetail");
export const InvoiceRequestAdminPageSchema = adminPage(InvoiceRequestAdminRowSchema);
export const AdminInvoiceSummarySchema = z.object({
  pending: z.int().nonnegative(),
  red_pending: z.int().nonnegative(),
  processed: z.int().nonnegative(),
  pendingAmountFen: z.string().regex(/^\d+$/),
  issuedThisMonth: z.object({ amountFen: z.string().regex(/^\d+$/), count: z.int().nonnegative() }),
});
const invoiceNumbers = {
  invoiceNo: z.string().regex(/^(?:\d{20}|\d{8})$/),
  invoiceCode: z
    .string()
    .regex(/^(?:\d{10}|\d{12})$/)
    .nullable()
    .optional(),
};
export const InvoiceIssueBodySchema = z.strictObject({
  ...invoiceNumbers,
  fileId: IdSchema.optional(),
  expressCompanyCode: z.string().min(1).max(64).optional(),
  trackingNo: z.string().trim().min(1).max(20).optional(),
  confirm: z.strictObject({ requestNo: z.string(), amountFen: z.int().positive() }),
});
export const InvoiceIssueRedBodySchema = z.strictObject({
  ...invoiceNumbers,
  fileId: IdSchema,
  redReason: z.string().max(100).default(""),
  confirm: z.strictObject({
    requestNo: z.string(),
    blueInvoiceNo: z.string(),
    amountFen: z.int().positive(),
  }),
});
export const InvoiceRejectBodySchema = z.strictObject({
  reasonCode: z.string().min(1).max(64),
  note: z.string().trim().min(1).max(200),
});
export type AdminInvoiceFilter = z.infer<typeof AdminInvoiceFilterSchema>;
export type AdminInvoiceListQuery = z.infer<typeof AdminInvoiceListQuerySchema>;
export type InvoiceIssueBody = z.infer<typeof InvoiceIssueBodySchema>;
export type InvoiceIssueRedBody = z.infer<typeof InvoiceIssueRedBodySchema>;
export type InvoiceRejectBody = z.infer<typeof InvoiceRejectBodySchema>;
