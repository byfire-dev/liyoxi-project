import type { Data } from "../src/lib/account-api";
import { ApiError } from "../src/lib/request";
import type { RequestLayer } from "../src/lib/request";
import type { Invoice, InvoiceBody, Payment } from "../src/sub/billing/invoices/api";

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-17T02:30:00.000Z";
export const invoiceContext: Data<"m.invoiceRequest.summary">["context"] = {
  invoiceTitle: {
    entityName: "演示花艺有限公司",
    taxNoMask: "9131**********1234",
    isVerified: true,
  },
  applyDefaults: {
    recipientName: "演示联系人",
    contactPhoneMask: "138****0000",
    loginPhoneMask: "139****0000",
    address: "演示市花园路一号",
    addrTel: "演示市花园路一号 021-00000000",
  },
};
export const invoicePayment: Payment = {
  paymentOrderId: id(1),
  orderNo: "202610170000001",
  type: "plan_new",
  status: "paid",
  channel: "bank_transfer",
  transferState: null,
  amountFen: 600000,
  title: "专业版 · 1 个月",
  createdAt: at,
  paidAt: at,
  invoiceItemName: "信息技术服务费",
  invoiceState: "eligible",
  activeInvoiceRequest: null,
  actions: ["submit-invoice"],
};
export function invoiceRecord(status: Invoice["status"] = "pending"): Invoice {
  return {
    invoiceRequestId: id(2),
    requestNo: "202610170000002",
    paymentOrderId: id(1),
    paymentOrderNo: invoicePayment.orderNo,
    paymentOrderTitle: invoicePayment.title,
    invoiceType: "normal",
    medium: "electronic",
    itemName: "信息技术服务费",
    status,
    amountFen: 600000,
    title: "演示花艺有限公司",
    taxNoMask: "9131**********1234",
    recvEmailMask: "f***@example.invalid",
    mailToMask: null,
    appliedAt: at,
    isHeldByRefund: false,
    reject: null,
    progressNote:
      status === "pending" ? "财务正在审核，开具后将在消息中心通知" : "电子发票已开具，可下载查阅",
    actions: [],
    docs:
      status === "issued" || status === "red_issued"
        ? [
            {
              docKind: "blue",
              invoiceNo: "202610170001",
              invoiceCode: null,
              amountFen: 600000,
              issuedAt: at,
              hasFile: true,
              fileFormat: "pdf",
              expressCompany: null,
              trackingNo: null,
              shippedAt: null,
              emailState: "sent",
            },
            ...(status === "red_issued"
              ? [
                  {
                    docKind: "red" as const,
                    invoiceNo: "202610170002",
                    invoiceCode: null,
                    amountFen: -600000,
                    issuedAt: at,
                    hasFile: true,
                    fileFormat: "ofd" as const,
                    expressCompany: null,
                    trackingNo: null,
                    shippedAt: null,
                    emailState: "failed",
                  },
                ]
              : []),
          ]
        : [],
  };
}
export function invoiceSummary(records: Invoice[]): Data<"m.invoiceRequest.summary"> {
  return {
    total: records.length,
    byStatus: {
      pending: records.filter((r) => r.status === "pending").length,
      issued: records.filter((r) => r.status === "issued").length,
      rejected: records.filter((r) => r.status === "rejected").length,
      red_pending: records.filter((r) => r.status === "red_pending").length,
      red_issued: records.filter((r) => r.status === "red_issued").length,
    },
    context: invoiceContext,
  };
}
export function offlineInvoiceRequest(scene: string): RequestLayer["request"] {
  let submitted = false,
    attempts = 0,
    signatures = 0;
  const records =
    scene === "invoice-pending"
      ? [invoiceRecord()]
      : scene === "invoice-issued"
        ? [invoiceRecord("red_issued")]
        : [];
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]) => {
    const globals = globalThis as {
      __LYX_INVOICE_CALLS__?: { path: string; method: string; key?: string }[];
    };
    (globals.__LYX_INVOICE_CALLS__ ??= []).push({
      path,
      method: options?.method ?? "GET",
      ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
    });
    const url = new URL(path, "https://fixture.invalid");
    if (url.pathname === "/m/payment-orders/summary")
      return {
        total: scene === "invoice-apply-error" && !submitted ? 1 : 0,
      } satisfies Data<"m.paymentOrder.summary"> as T;
    if (url.pathname === "/m/payment-orders")
      return {
        items: scene === "invoice-apply-error" && !submitted ? [invoicePayment] : [],
        nextCursor: null,
        hasMore: false,
      } satisfies Data<"m.paymentOrder.list"> as T;
    if (url.pathname === "/m/invoice-requests/summary") return invoiceSummary(records) as T;
    if (url.pathname === "/m/invoice-requests" && options?.method === "POST") {
      if (scene === "invoice-apply-error" && ++attempts === 1)
        throw new ApiError({
          error: "PRECONDITION_CHANGED",
          message: "fixture",
          status: 409,
          requestId: "fixture",
        });
      const body = options.data as InvoiceBody;
      if (body.paymentOrderId !== invoicePayment.paymentOrderId) throw new Error("FIXTURE_INPUT");
      submitted = true;
      records.splice(0, records.length, invoiceRecord());
      return records[0] as T;
    }
    if (url.pathname === "/m/invoice-requests")
      return {
        items: records,
        nextCursor: null,
        hasMore: false,
      } satisfies Data<"m.invoiceRequest.list"> as T;
    if (url.pathname.endsWith("/download-urls")) {
      const red = (options?.data as { docKind: string }).docKind === "red";
      return {
        url: `https://fixture.invalid/invoice-${++signatures}.${red ? "ofd" : "pdf"}`,
        expiresAt: "2099-10-17T02:35:00.000Z",
        fileFormat: red ? "ofd" : "pdf",
        fileName: `invoice-${red ? "red.ofd" : "blue.pdf"}`,
      } satisfies Data<"m.invoiceRequest.downloadUrls"> as T;
    }
    throw new Error("FIXTURE_ROUTE");
  };
}
