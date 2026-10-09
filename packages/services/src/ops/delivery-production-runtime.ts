import type { Assembly } from "../kernel/index.js";
import { createProductionChecked } from "../delivery/index.js";
import type { ProductionCheckedDeps } from "../delivery/index.js";

/** Only this runtime's checked subscriber is replaced; closing never falls back to another scope. */
export function createDeliveryProductionAssembly(base: Assembly) {
  let handle: ReturnType<typeof createProductionChecked> | undefined,
    closed = false;
  const subscribers = base.subscribers.map((item) =>
    item.name === "delivery.onProductionChecked"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) => {
            if (closed || !handle) throw new TypeError("本交付制作运行时尚未绑定或已经关闭");
            return handle(...args);
          },
        }
      : item,
  );
  return {
    assembly: {
      ...base,
      subscribers,
      subscriber: (name: string) => subscribers.find((item) => item.name === name),
    },
    attach(deps: ProductionCheckedDeps) {
      if (closed || handle) throw new TypeError("交付制作运行时只能绑定一次");
      handle = createProductionChecked(deps);
    },
    close() {
      closed = true;
      handle = undefined;
    },
  };
}
