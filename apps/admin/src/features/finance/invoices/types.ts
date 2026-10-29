import type {
  z,
  InvoiceRequestAdminDetailSchema,
  InvoiceRequestAdminRowSchema,
  InvoiceIssueBody,
  InvoiceIssueRedBody,
  InvoiceRejectBody,
} from "@liyoxi/contract";

export type InvoiceDetail = z.infer<typeof InvoiceRequestAdminDetailSchema>;
export type InvoiceRow = z.infer<typeof InvoiceRequestAdminRowSchema>;
export type InvoiceAction = "issue" | "issue-red" | "reject" | "resend";
export type InvoiceCommand =
  | { action: "issue"; body: InvoiceIssueBody }
  | { action: "issue-red"; body: InvoiceIssueRedBody }
  | { action: "reject"; body: InvoiceRejectBody }
  | { action: "resend" };
export interface InvoiceDraft {
  invoiceNo: string;
  invoiceCode: string;
  fileId: string | null;
  expressCompanyCode: string;
  trackingNo: string;
  reasonCode: string;
  note: string;
}
