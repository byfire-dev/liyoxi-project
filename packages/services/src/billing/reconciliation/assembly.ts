import type { Assembly, RecurringRunContext } from "../../kernel/index.js";
import type { ReconciliationDeps } from "./context.js";
import { downloadBills, receiptDigest } from "./jobs.js";
export async function unboundReconciliationJob(): Promise<never> {
  throw new TypeError("账单运行时未绑定或已关闭");
}
export function createReconciliationAssembly(base: Assembly) {
  let deps: ReconciliationDeps | undefined,
    closed = false;
  const current = () => {
    if (closed || !deps) throw new TypeError("账单运行时未绑定或已关闭");
    return deps;
  };
  const recurringJobs = base.recurringJobs.map((j) =>
    j.kind === "bill.download"
      ? { ...j, run: (ctx: RecurringRunContext) => downloadBills(current(), ctx) }
      : j.kind === "receipt.daily_digest"
        ? { ...j, run: (ctx: RecurringRunContext) => receiptDigest(current(), ctx) }
        : j,
  );
  if (
    recurringJobs.filter((j) => j.kind === "bill.download" || j.kind === "receipt.daily_digest")
      .length !== 2
  )
    throw new TypeError("账单必须复用唯一两项周期登记");
  const assembly: Assembly = {
    ...base,
    recurringJobs,
    recurringJob: (kind) => recurringJobs.find((j) => j.kind === kind),
  };
  return {
    assembly,
    attach(value: ReconciliationDeps) {
      if (closed || deps) throw new TypeError("账单运行时只能绑定一次");
      deps = value;
    },
    close() {
      closed = true;
      deps = undefined;
    },
  };
}
