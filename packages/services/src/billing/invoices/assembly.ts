import type { Assembly, Tx, DeliveredEvent, KeyedPort } from "../../kernel/index.js";
import { handleInvoiceSla, onInvoiceCalendarImported, lockBillingCalendarOrders } from "./sla.js";
import { onTransferCalendarImported } from "../payment/calendar.js";
import { onInvoiceMailResult } from "./mail.js";
import type { InvoiceRuntimeDeps } from "./context.js";
export const unboundInvoiceMailResult = async () => {
  throw new TypeError("发票通知结果尚未绑定");
};
export function createInvoiceAssembly(base: Assembly) {
  let deps: InvoiceRuntimeDeps | undefined,
    closed = false;
  const current = () => {
    if (closed || !deps) throw new TypeError("发票运行时尚未绑定或已关闭");
    return deps;
  };
  const subscribers = base.subscribers.map((item) =>
    item.name === "billing.onMailResult"
      ? {
          ...item,
          handle: async (tx: Tx, event: DeliveredEvent) => {
            current();
            await onInvoiceMailResult(tx, event);
          },
        }
      : item.name === "billing.onCalendarImported"
        ? {
            ...item,
            handle: async (tx: Tx, event: DeliveredEvent) => {
              const batch = await lockBillingCalendarOrders(tx, event);
              if (!batch) return;
              await onTransferCalendarImported(tx, current(), event, batch.proofIds);
              await onInvoiceCalendarImported(tx, current(), event, batch.invoiceIds);
            },
          }
        : item,
  );
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "sla.breach"
      ? {
          ...item,
          handle: (tx: Tx, timer: Parameters<typeof handleInvoiceSla>[2]) =>
            timer.subjectType === "invoice_request"
              ? handleInvoiceSla(tx, current(), timer)
              : item.handle(tx, timer),
        }
      : item,
  );
  if (
    subscribers.filter((s) => s.name === "billing.onMailResult").length !== 1 ||
    subscribers.filter((s) => s.name === "billing.onCalendarImported").length !== 1 ||
    timerHandlers.filter((t) => t.kind === "sla.breach").length !== 1
  )
    throw new TypeError("发票必须复用唯一结果、日历、SLA登记");
  const assembly: Assembly = {
    ...base,
    subscribers,
    timerHandlers,
    subscriber: (name) => subscribers.find((s) => s.name === name),
    timerHandler: (kind) => timerHandlers.find((t) => t.kind === kind),
    portEntries<T>(port: KeyedPort<T>) {
      return base.portEntries(port);
    },
  };
  return {
    assembly,
    attach(value: InvoiceRuntimeDeps) {
      if (closed || deps) throw new TypeError("发票运行时只能绑定一次");
      deps = value;
    },
    close() {
      closed = true;
      deps = undefined;
    },
  };
}
