import type { Assembly, DeliveredEvent, Tx } from "../../kernel/index.js";
import type { DeliveryRef } from "../../events/index.js";
import { createShipping, SHIPPING_SUBSCRIBER } from "./shipping.js";
import type { ShippingDeps } from "./shipping.js";

export async function unboundShipping(): Promise<never> {
  throw new TypeError("发货运行时未绑定或已关闭");
}
/** 每次装配独立闭包；API/worker及同进程多runtime不共享可变绑定。 */
export function createShippingAssembly(base: Assembly) {
  let service: ReturnType<typeof createShipping> | undefined,
    closed = false;
  const current = () => {
    if (closed || !service) throw new TypeError("发货运行时未绑定或已关闭");
    return service;
  };
  const subscribers = base.subscribers.map((s) =>
    s.name === SHIPPING_SUBSCRIBER
      ? { ...s, handle: (tx: Tx, event: DeliveredEvent) => current().consume(tx, event) }
      : s,
  );
  if (subscribers.filter((s) => s.name === SHIPPING_SUBSCRIBER).length !== 1)
    throw new TypeError("发货必须复用唯一订阅登记");
  const assembly: Assembly = {
    ...base,
    subscribers,
    subscriber: (name) => subscribers.find((s) => s.name === name),
  };
  return {
    assembly,
    attach(deps: ShippingDeps) {
      if (closed || service) throw new TypeError("发货运行时只能绑定一次");
      service = createShipping(deps);
    },
    async beforeConsume(ref: DeliveryRef, event: DeliveredEvent) {
      if (ref.subscriber === SHIPPING_SUBSCRIBER) await current().prepare(event);
    },
    close() {
      closed = true;
      service?.close();
      service = undefined;
    },
  };
}
