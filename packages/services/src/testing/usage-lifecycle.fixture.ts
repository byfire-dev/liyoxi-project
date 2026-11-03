import { createRuntime } from "../runtime.js";
// Real cross-domain composition for W6-01 tests. No alternate domain writer or database outcome stub.
import { bindOrder, createUsageLifecycle, deriveOrder, registration } from "../order/index.js";
import { orderSidePort } from "../delivery/index.js";
import type { DeliveryCoreDeps, OrderSide } from "../delivery/index.js";
import { lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createTimers } from "../timers/index.js";

export function bindUsageLifecycleOrderForTest(
  h: Parameters<typeof bindOrder>[0] & {
    rederiveHook: { run?: OrderSide["rederive"] };
  },
) {
  const close = bindOrder(h);
  const entry = registration.portImplementations.find((r) => r.port === orderSidePort);
  if (!entry) throw new Error("实际orderSide登记缺失");
  h.rederiveHook.run = (entry.impl as OrderSide).rederive;
  return close;
}
export function createUsageLifecycleForTest(deps: DeliveryCoreDeps) {
  return createUsageLifecycle(deps, createTimers({ assembly: deps.assembly }));
}
export async function openUsageCancellationForTest(
  tx: Tx,
  deps: DeliveryCoreDeps,
  orderId: string,
  requestId: string,
) {
  await lockRows(tx, "drama_order", [orderId]);
  return deriveOrder(tx, { assembly: deps.assembly, clock: deps.clock, flow: deps.flow }, orderId, {
    openedCancelRequestId: requestId,
  });
}

export function createUsageLifecycleRuntimeForTest(options: Parameters<typeof createRuntime>[0]) {
  return createRuntime(options);
}
