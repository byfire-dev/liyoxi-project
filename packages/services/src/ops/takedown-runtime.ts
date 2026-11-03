import { invariantNow } from "../kernel/index.js";
import type { Assembly } from "../kernel/index.js";
import type { PublishTakedown } from "../publish/index.js";

/** An outer scope preserves patrol's I7 contribution and its lock order. */
export function createTakedownAssembly(base: Assembly) {
  for (const kind of ["takedown.create", "takedown.overdue"])
    if (base.timerHandlers.filter((h) => h.kind === kind).length !== 1)
      throw new TypeError("下架运行时需要唯一的两个timer登记");
  if (
    base.subscribers.filter((s) => s.name === "publish.onCalendarImported").length !== 1 ||
    base.invariants.filter((h) => h.code === "timers.I7").length !== 1 ||
    base.invariants.filter((h) => h.code === "publish.I16").length !== 1
  )
    throw new TypeError("下架运行时需要唯一日历订阅与不变量登记");
  let current: PublishTakedown | undefined,
    closed = false;
  const pending = new Set<Promise<unknown>>();
  function run<T>(fn: (s: PublishTakedown) => Promise<T>) {
    if (closed || !current) throw new TypeError("本下架运行时未绑定或已关闭");
    const promise = fn(current);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  const timerHandlers = base.timerHandlers.map((h) =>
    h.kind === "takedown.create" || h.kind === "takedown.overdue"
      ? {
          ...h,
          handle: (...args: Parameters<typeof h.handle>) =>
            run((s) => (h.kind === "takedown.create" ? s.create(...args) : s.overdue(...args))),
        }
      : h,
  );
  const subscribers = base.subscribers.map((h) =>
    h.name === "publish.onCalendarImported"
      ? {
          ...h,
          handle: (...args: Parameters<typeof h.handle>) =>
            run((s) => s.onCalendarImported(...args)),
        }
      : h,
  );
  const invariants = base.invariants.map((h) =>
    h.code === "timers.I7" || h.code === "publish.I16"
      ? {
          ...h,
          run: ((tx, scope, ctx) =>
            run(async (s) => {
              if (h.code === "publish.I16") return s.reconcile(tx, invariantNow(ctx));
              if (!h.run) throw new TypeError("定时器I7缺少已有巡检贡献");
              const existing = await h.run(tx, scope, ctx);
              return [...existing, ...(await s.reconcileTimers(tx, invariantNow(ctx)))];
            })) as NonNullable<typeof h.run>,
        }
      : h,
  );
  const assembly: Assembly = {
    ...base,
    timerHandlers,
    subscribers,
    invariants,
    timerHandler: (kind) => timerHandlers.find((h) => h.kind === kind),
    subscriber: (name) => subscribers.find((h) => h.name === name),
    invariant: (code) => invariants.find((h) => h.code === code),
  };
  return {
    assembly,
    attach(value: PublishTakedown) {
      if (closed || current) throw new TypeError("下架运行时只能绑定一次");
      current = value;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      current = undefined;
    },
  };
}
