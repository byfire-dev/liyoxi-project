import { z } from "../../zod.js";
import { IdSchema, InstantSchema, DictRefSchema, orNull, openEnum } from "../../common/index.js";
export const InvoiceStatusSchema = openEnum([
  "pending",
  "issued",
  "rejected",
  "red_pending",
  "red_issued",
]);
export const InvoiceTypeSchema = z.enum(["normal", "special"]);
export const InvoiceMediumSchema = z.enum(["electronic", "paper"]);
export const InvoiceFileFormatSchema = z.enum(["pdf", "ofd", "xml"]);
export const InvoiceRequestParamsSchema = z.object({ invoiceRequestId: IdSchema });
export const InvoiceDocViewSchema = z
  .object({
    docKind: z.enum(["blue", "red"]),
    invoiceNo: z.string(),
    invoiceCode: z.string().nullable(),
    amountFen: z.int(),
    issuedAt: InstantSchema,
    hasFile: z.boolean(),
    fileFormat: InvoiceFileFormatSchema.nullable(),
    expressCompany: orNull(DictRefSchema),
    trackingNo: z.string().nullable(),
    shippedAt: InstantSchema.nullable(),
    emailState: openEnum(["none", "queued", "sent", "failed", "skipped"]),
  })
  .openapi("InvoiceDocView");
export const InvoiceRejectSchema = z.object({
  kind: z.enum(["manual", "order_refunded"]),
  reason: orNull(DictRefSchema),
  note: z.string().nullable(),
  rejectedAt: InstantSchema,
});
export const InvoiceRequestCardSchema = z
  .object({
    invoiceRequestId: IdSchema,
    requestNo: z.string(),
    paymentOrderId: IdSchema,
    paymentOrderNo: z.string(),
    paymentOrderTitle: z.string(),
    invoiceType: InvoiceTypeSchema,
    medium: InvoiceMediumSchema,
    itemName: z.string(),
    status: InvoiceStatusSchema,
    amountFen: z.int().positive(),
    title: z.string(),
    taxNoMask: z.string(),
    recvEmailMask: z.string().nullable(),
    mailToMask: z.string().nullable(),
    appliedAt: InstantSchema,
    isHeldByRefund: z.boolean(),
    reject: orNull(InvoiceRejectSchema),
    progressNote: z.string(),
    docs: z.array(InvoiceDocViewSchema),
    actions: z.array(z.string()),
  })
  .openapi("InvoiceRequestCard");
export const InvoiceRequestFilterSchema = z.object({
  status: z
    .string()
    .refine((v) =>
      v
        .split(",")
        .every((s) => ["pending", "issued", "rejected", "red_pending", "red_issued"].includes(s)),
    )
    .optional(),
  paymentOrderId: IdSchema.optional(),
  no: z.string().min(1).max(64).optional(),
});
export const InvoiceRequestListQuerySchema = InvoiceRequestFilterSchema.extend({
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const InvoiceRequestListSchema = z.object({
  items: z.array(InvoiceRequestCardSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export const InvoiceRequestSummarySchema = z.object({
  total: z.int().nonnegative(),
  byStatus: z.object({
    pending: z.int().nonnegative(),
    issued: z.int().nonnegative(),
    rejected: z.int().nonnegative(),
    red_pending: z.int().nonnegative(),
    red_issued: z.int().nonnegative(),
  }),
  context: z.object({
    invoiceTitle: z.object({
      entityName: z.string().nullable(),
      taxNoMask: z.string().nullable(),
      isVerified: z.boolean(),
    }),
    applyDefaults: z.object({
      recipientName: z.string().nullable(),
      contactPhoneMask: z.string().nullable(),
      loginPhoneMask: z.string().nullable(),
      address: z.string().nullable(),
      addrTel: z.string().nullable(),
    }),
  }),
});
export const InvoiceRequestCreateBodySchema = z
  .strictObject({
    paymentOrderId: IdSchema,
    invoiceType: InvoiceTypeSchema,
    medium: InvoiceMediumSchema,
    addrTel: z.string().trim().min(1).max(100).optional(),
    bankAccount: z.string().trim().min(1).max(100).optional(),
    recvEmail: z.email().max(100).optional(),
    mailTo: z
      .strictObject({
        recipientName: z.string().trim().min(1).max(20),
        phoneSource: z.enum(["login", "store_contact", "input"]),
        phone: z
          .string()
          .regex(/^(?:1\d{10}|0\d{2,3}-?\d{7,8})$/)
          .optional(),
        address: z.string().trim().min(5).max(120),
      })
      .optional(),
  })
  .refine(
    (v) =>
      (v.invoiceType !== "normal" || v.medium === "electronic") &&
      (v.invoiceType !== "special" || !!(v.addrTel && v.bankAccount)) &&
      (v.medium === "electronic" ? !!v.recvEmail : !!v.mailTo) &&
      (!v.mailTo ||
        (v.mailTo.phoneSource === "input" ? !!v.mailTo.phone : v.mailTo.phone === undefined)),
    "开票必填信息不完整",
  );
export const InvoiceDownloadBodySchema = z.object({
  docKind: z.enum(["blue", "red"]).default("blue"),
});
export const InvoiceDownloadSchema = z.object({
  url: z.url(),
  expiresAt: InstantSchema,
  fileFormat: InvoiceFileFormatSchema,
  fileName: z.string(),
});
export type InvoiceRequestCreateBody = z.infer<typeof InvoiceRequestCreateBodySchema>;
export type InvoiceRequestListQuery = z.infer<typeof InvoiceRequestListQuerySchema>;
export type InvoiceRequestFilter = z.infer<typeof InvoiceRequestFilterSchema>;
