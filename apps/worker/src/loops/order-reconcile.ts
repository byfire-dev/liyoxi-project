import type { DomainLoopDef } from "../loop.js";

export const orderReconcile: DomainLoopDef = {
  name: "flow_reconcile_sweep",
  intervalMs: 5 * 60_000,
  run: (services, beat) => services.reconcileOrders(beat),
};
