import type { DomainLoopDef } from "../loop.js";
/** x01 §4.3: five-second recovery/enqueue, two in-process calls when Redis is down. */
export const notifyScan: DomainLoopDef = {
  name: "notify_scan",
  intervalMs: 5_000,
  run: async (services, beat) => {
    const result = await services.scanNotify();
    beat();
    return result;
  },
};
