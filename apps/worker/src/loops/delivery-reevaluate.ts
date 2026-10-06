import type { DomainLoopDef } from "../loop.js";
export const deliveryReevaluate: DomainLoopDef = {
  name: "flow_reevaluate_sweep",
  intervalMs: 5 * 60_000,
  run: async (services, beat) => {
    const result = await services.reevaluateDelivery();
    beat();
    return result;
  },
};
