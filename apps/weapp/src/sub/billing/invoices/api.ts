import type { operations } from "@liyoxi/contract/types/merchant";
import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export type InvoiceBody = NonNullable<
  operations["m.invoiceRequest.create"]["requestBody"]
>["content"]["application/json"];
export type Invoice = Data<"m.invoiceRequest.list">["items"][number];
export type Payment = Data<"m.paymentOrder.list">["items"][number];
export type InvoiceContext = Data<"m.invoiceRequest.summary">["context"];
export type SignedInvoice = Data<"m.invoiceRequest.downloadUrls">;
export function createInvoiceApi(call: RequestLayer["request"]) {
  const page = (path: string, cursor?: string | null) =>
    `${path}${path.includes("?") ? "&" : "?"}limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  return {
    payments: (cursor?: string | null) =>
      call<Data<"m.paymentOrder.list">>(
        page("/m/payment-orders?invoiceState=eligible,applying", cursor),
      ),
    paymentSummary: () =>
      call<Data<"m.paymentOrder.summary">>("/m/payment-orders/summary?invoiceState=eligible"),
    invoices: (cursor?: string | null) =>
      call<Data<"m.invoiceRequest.list">>(page("/m/invoice-requests", cursor)),
    summary: () => call<Data<"m.invoiceRequest.summary">>("/m/invoice-requests/summary"),
    create: (data: InvoiceBody, key: string) =>
      call<Data<"m.invoiceRequest.create">>("/m/invoice-requests", {
        method: "POST",
        data,
        idempotencyKey: key,
      }),
    download: (id: string, docKind: "blue" | "red") =>
      call<SignedInvoice>(`/m/invoice-requests/${encodeURIComponent(id)}/download-urls`, {
        method: "POST",
        data: { docKind },
      }),
  };
}
export type InvoiceApi = ReturnType<typeof createInvoiceApi>;
