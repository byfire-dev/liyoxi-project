import { AppError } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import { sendQuotaExceeded } from "./entitlement.js";
import { dispatchEvent } from "./dispatch.js";
import { clearDeletedMerchant } from "./cleanup.js";
import { deliveryRunner } from "./delivery.js";
import { remindScan } from "./reminders.js";
import { directSender } from "./direct.js";
import { validateConfiguration } from "./configuration.js";
import { fanoutRunner } from "./fanout.js";
import type { NotifyQueueRef, NotifyQueueTask } from "./context.js";

export function createNotifyDispatcher(deps: NotifyDispatchDeps) {
  const runner = deliveryRunner(deps);
  const direct = directSender(deps);
  const fanout = fanoutRunner(deps);
  return {
    ...runner,
    deliver: (ref: NotifyQueueRef) =>
      "fanoutId" in ref ? fanout.deliver(ref) : runner.deliver(ref),
    scan: async (enqueue: (ref: NotifyQueueTask) => Promise<void>) =>
      (await runner.scan(enqueue)) + (await fanout.scan(enqueue)),
    validateConfiguration: () => validateConfiguration(deps),
    sendDirect: direct.sendDirect,
    sendQuotaExceeded: (
      tx: Parameters<typeof sendQuotaExceeded>[0],
      event: Parameters<typeof sendQuotaExceeded>[2],
    ) => sendQuotaExceeded(tx, deps, event),
    close: async () => {
      await Promise.all([runner.close(), direct.close(), fanout.close()]);
    },
    onEvent: (
      tx: Parameters<typeof dispatchEvent>[0],
      event: Parameters<typeof dispatchEvent>[2],
    ) => dispatchEvent(tx, deps, event),
    onMerchantUserDeleted: (
      tx: Parameters<typeof clearDeletedMerchant>[0],
      event: Parameters<typeof clearDeletedMerchant>[2],
    ) => clearDeletedMerchant(tx, deps, event),
    remindScan: (context: Parameters<typeof remindScan>[1]) => remindScan(deps, context),
  };
}
export type NotifyDispatcherService = ReturnType<typeof createNotifyDispatcher>;
/** Raw registrations carry metadata; only the runtime's scoped Assembly can execute them. */
export function boundNotifyDispatcher(): NotifyDispatcherService {
  throw new AppError("INTERNAL", { message: "通知派发需要本运行时的领域装配" });
}

export function boundNotifyAssembly(): NotifyDispatchDeps["assembly"] {
  throw new AppError("INTERNAL", { message: "通知领域事实需要本运行时的领域装配" });
}
