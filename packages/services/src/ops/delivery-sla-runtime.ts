import type { Assembly } from "../kernel/index.js";
import { handleDeliveryStageSlaBreach } from "../delivery/index.js";
import type { DeliveryStageSlaDeps } from "../delivery/index.js";

/** One existing sla.breach registration; only delivery's fixed subject is dispatched here. */
export function createDeliverySlaAssembly(base: Assembly) {
  if (base.timerHandlers.filter((item) => item.kind === "sla.breach").length !== 1)
    throw new TypeError("交付时限需要唯一的 sla.breach 处理器");
  let deps: DeliveryStageSlaDeps | undefined,
    closed = false;
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "sla.breach"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) => {
            if (args[1].subjectType !== "delivery_ticket_stage") return item.handle(...args);
            if (closed || !deps) throw new TypeError("本交付时限运行时尚未绑定或已经关闭");
            return handleDeliveryStageSlaBreach(args[0], deps, args[1]);
          },
        }
      : item,
  );
  const index = new Map(timerHandlers.map((item) => [item.kind, item]));
  return {
    assembly: { ...base, timerHandlers, timerHandler: (kind: string) => index.get(kind) },
    attach(value: DeliveryStageSlaDeps) {
      if (closed || deps) throw new TypeError("交付时限运行时只能绑定一次");
      deps = value;
    },
    close() {
      closed = true;
      deps = undefined;
    },
  };
}
