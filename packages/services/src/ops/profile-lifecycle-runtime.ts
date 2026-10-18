import { PROFILE_TENANT_EVENTS } from "../profile/index.js";
import type { ProfileTenantLifecycle } from "../profile/index.js";
import type { Assembly } from "../kernel/index.js";

/** 只替换本实例的唯一订阅 handle，不借用 API 缓存或进程全局绑定。 */
export function createProfileLifecycleAssembly(base: Assembly) {
  const registered = base.subscribers.filter((item) => item.name === "profile.onTenantLifecycle");
  if (
    registered.length !== 1 ||
    [...registered[0]!.events].sort().join() !== [...PROFILE_TENANT_EVENTS].sort().join()
  )
    throw new TypeError("profile 生命周期需要唯一且完整的五事件订阅登记");
  let service: ProfileTenantLifecycle | undefined;
  let closed = false;
  const current = () => {
    if (closed || !service) throw new TypeError("本 profile 生命周期运行时尚未绑定或已经关闭");
    return service;
  };
  const subscribers = base.subscribers.map((item) =>
    item.name === "profile.onTenantLifecycle"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) => current().onTenantLifecycle(...args),
        }
      : item,
  );
  const assembly: Assembly = {
    ...base,
    subscribers,
    subscriber: (name) => subscribers.find((item) => item.name === name),
  };
  return {
    assembly,
    attach(value: ProfileTenantLifecycle) {
      if (closed || service) throw new TypeError("profile 生命周期运行时只能绑定一次");
      service = value;
    },
    close() {
      closed = true;
      service = undefined;
    },
  };
}
