import type { Assembly } from "../kernel/index.js";
import type { UsageLifecycle } from "../order/index.js";

/** Owned by this API/worker. Shutdown rejects in-flight transactions before commit. */
export function createUsageLifecycleAssembly(base: Assembly) {
  for (const kind of ["usage.end", "usage.resync"])
    if (base.timerHandlers.filter((r) => r.kind === kind).length !== 1)
      throw new TypeError(`使用期需要唯一 ${kind} 处理器`);
  if (base.subscribers.filter((r) => r.name === "publish.onLicenseExtended").length !== 1)
    throw new TypeError("使用期需要唯一版权顺延订阅者");
  let service: UsageLifecycle | undefined,
    closed = false;
  const pending = new Set<Promise<unknown>>();
  const current = () => {
    if (!service || closed) throw new TypeError("本使用期运行时未绑定或已关闭");
    return service;
  };
  function run<T>(work: (s: UsageLifecycle) => Promise<T>) {
    const active = work(current()).then((result) => {
      current();
      return result;
    });
    pending.add(active);
    void active.finally(() => pending.delete(active)).catch(() => undefined);
    return active;
  }
  const timerHandlers = base.timerHandlers.map((r) =>
    ["usage.end", "usage.resync"].includes(r.kind)
      ? { ...r, handle: (...args: Parameters<typeof r.handle>) => run((s) => s.handle(...args)) }
      : r,
  );
  const subscribers = base.subscribers.map((r) =>
    r.name === "publish.onLicenseExtended"
      ? {
          ...r,
          handle: (...args: Parameters<typeof r.handle>) =>
            run((s) => s.onLicenseExtended(...args)),
        }
      : r,
  );
  const assembly: Assembly = {
    ...base,
    timerHandlers,
    subscribers,
    timerHandler: (kind) => timerHandlers.find((r) => r.kind === kind),
    subscriber: (name) => subscribers.find((r) => r.name === name),
  };
  return {
    assembly,
    attach(value: UsageLifecycle) {
      if (closed || service) throw new TypeError("使用期运行时只能绑定一次");
      service = value;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      service = undefined;
    },
  };
}
