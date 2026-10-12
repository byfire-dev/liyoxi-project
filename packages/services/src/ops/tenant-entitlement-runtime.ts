import { notifyReadPort } from "../kernel/index.js";
import type { Assembly, KeyedPort, NotifyReader } from "../kernel/index.js";
import { createTenantEntitlement, TENANT_ENTITLEMENT_EVENTS } from "../tenant/index.js";
import type { TenantEntitlement } from "../tenant/index.js";
import type { NotifyDispatcherService } from "../notify/index.js";

/** subscriber 数组、lookup 和所属 reader 共用本实例闭包；关闭后旧 handle 也拒绝。 */
export function createTenantEntitlementAssembly(base: Assembly) {
  const registered = base.subscribers.filter((item) => item.name === "tenant.onEntitlementChanged");
  if (
    registered.length !== 1 ||
    [...registered[0]!.events].sort().join() !== [...TENANT_ENTITLEMENT_EVENTS].sort().join()
  )
    throw new TypeError("权益变动需要唯一完整的两事件登记");
  let service: TenantEntitlement | undefined;
  let closed = false;
  const current = () => {
    if (closed || !service) throw new TypeError("本权益变动运行时尚未绑定或已经关闭");
    return service;
  };
  const reader: NotifyReader = (tx, eventId: string) => current().readForNotify(tx, eventId);
  const subscribers = base.subscribers.map((item) =>
    item.name === "tenant.onEntitlementChanged"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) =>
            current().onEntitlementChanged(...args),
        }
      : item,
  );
  const portImplementations = base.portImplementations.map((item) =>
    item.port === notifyReadPort && item.key === "tenantQuotaForNotify"
      ? { ...item, impl: reader }
      : item,
  );
  if (
    portImplementations.filter(
      (item) => item.port === notifyReadPort && item.key === "tenantQuotaForNotify",
    ).length !== 1
  )
    throw new TypeError("权益变动需要唯一所属通知 reader");
  const assembly: Assembly = {
    ...base,
    subscribers,
    portImplementations,
    subscriber: (name) => subscribers.find((item) => item.name === name),
    portEntries<T>(port: KeyedPort<T>) {
      const entries = new Map(base.portEntries(port));
      for (const item of portImplementations)
        if (
          item.port === port &&
          item.port === notifyReadPort &&
          item.key === "tenantQuotaForNotify"
        )
          entries.set(item.key, item.impl as T);
      return entries;
    },
  };
  return {
    assembly,
    attach(value: TenantEntitlement) {
      if (closed || service) throw new TypeError("权益变动运行时只能绑定一次");
      service = value;
    },
    close() {
      closed = true;
      service = undefined;
    },
  };
}
export function createRuntimeTenantEntitlement(
  input: Omit<Parameters<typeof createTenantEntitlement>[0], "notify"> & {
    notify: Pick<NotifyDispatcherService, "sendQuotaExceeded">;
  },
): TenantEntitlement {
  return createTenantEntitlement({
    ...input,
    notify: (tx, event) => input.notify.sendQuotaExceeded(tx, event),
  });
}
