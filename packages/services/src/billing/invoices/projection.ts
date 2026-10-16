import type { Tx } from "../../kernel/index.js";
import type { BillingOrder } from "@liyoxi/db";
import { paramsAt } from "../../config/index.js";
import { invoiceReasons } from "./context.js";
const activeInvoiceStatuses = ["pending", "issued", "red_pending"];
/** Shared real invoice projection; future refund writers keep order290→invoice330. */
export async function orderInvoiceFacts(tx: Tx, order: BillingOrder, now: Date) {
  const rows = await tx.invoiceRequest.findMany({
      where: { billingOrderId: order.id },
      orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
    }),
    active = rows.find((r) => activeInvoiceStatuses.includes(r.status)) ?? null,
    latest = rows[0] ?? null,
    reasons = await invoiceReasons(tx, order, true),
    params = await paramsAt(tx, ["invoice.apply_within_days"], now),
    days = params["invoice.apply_within_days"],
    expired =
      days !== null &&
      order.paidAt !== null &&
      now.getTime() > order.paidAt.getTime() + days * 86400000;
  return {
    invoiceState: active
      ? active.status === "pending"
        ? "applying"
        : "invoiced"
      : reasons.length
        ? "not_eligible"
        : expired
          ? "expired"
          : "eligible",
    activeInvoiceRequest: active
      ? { invoiceRequestId: active.id, requestNo: active.requestNo, status: active.status }
      : null,
    invoice: {
      state: latest
        ? latest.status === "pending"
          ? "requested"
          : latest.status
        : reasons.length
          ? "not_eligible"
          : "not_requested",
      latest: latest
        ? {
            invoiceRequestId: latest.id,
            requestNo: latest.requestNo,
            status: latest.status,
            invoiceType: latest.invoiceType,
            medium: latest.medium,
          }
        : null,
    },
  };
}
