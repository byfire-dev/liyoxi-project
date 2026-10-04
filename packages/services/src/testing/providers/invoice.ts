// 假自动开票：按申请单号发一个编的发票号。同一个申请单号重复开，给同一个发票号。

import { ok } from "../../providers/types.js";
import type { InvoiceProvider, ProviderMethodName } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<InvoiceProvider>;

export interface FakeIssuedInvoice {
  invoiceNo: string;
  requestNo: string;
  title: string;
  taxNo?: string;
  amountFen: number;
}

export interface FakeInvoice extends InvoiceProvider, FakeControl<Method> {
  /** 开出去的发票，键是申请单号 */
  readonly issued: Map<string, FakeIssuedInvoice>;
}

export function createFakeInvoice(options: { clock?: FakeClock } = {}): FakeInvoice {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const issued = new Map<string, FakeIssuedInvoice>();

  return {
    status: "fake",
    configured: true,
    ...core.control,
    issued,

    issue: (input) =>
      core.run("issue", input, () => {
        const existing = issued.get(input.requestNo);
        if (existing) return ok({ invoiceNo: existing.invoiceNo });
        const invoiceNo = `FAKE-INV-${String(issued.size + 1).padStart(6, "0")}`;
        issued.set(input.requestNo, { invoiceNo, ...input });
        return ok({ invoiceNo });
      }),
  };
}
