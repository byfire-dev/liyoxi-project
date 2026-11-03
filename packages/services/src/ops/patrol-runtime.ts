import type { Assembly } from "../kernel/index.js";
import { invariantNow } from "../kernel/index.js";
import type { PublishPatrol } from "../publish/index.js";
/** Instance-owned handlers; close rejects new work and drains calls already admitted. */
export function createPatrolAssembly(base: Assembly) {
  if (
    base.timerHandlers.filter((h) => h.kind === "patrol.followup").length !== 1 ||
    base.recurringJobs.filter((h) => h.kind === "patrol.weekly_generate").length > 1
  )
    throw new TypeError("巡检需要唯一timer且不能重复周任务登记");
  if (base.invariants.filter((h) => h.code === "timers.I7").length !== 1)
    throw new TypeError("定时器一致性需要唯一I7登记");
  let current: PublishPatrol | undefined,
    closed = false;
  const pending = new Set<Promise<unknown>>();
  const service = () => {
    if (closed || !current) throw new TypeError("本巡检运行时未绑定或已关闭");
    return current;
  };
  function run<T>(fn: (s: PublishPatrol) => Promise<T>) {
    const result = fn(service());
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => undefined);
    return result;
  }
  const timerHandlers = base.timerHandlers.map((h) =>
    h.kind === "patrol.followup"
      ? { ...h, handle: (...args: Parameters<typeof h.handle>) => run((s) => s.followup(...args)) }
      : h,
  );
  const recurringJobs = base.recurringJobs.map((h) =>
    h.kind === "patrol.weekly_generate"
      ? { ...h, run: (...args: Parameters<typeof h.run>) => run((s) => s.weekly(...args)) }
      : h,
  );
  const invariants = base.invariants.map((h) =>
    ["publish.I15", "timers.I7"].includes(h.code)
      ? {
          ...h,
          run: ((tx, _scope, ctx) =>
            run((s) =>
              h.code === "timers.I7"
                ? s.reconcileTimers(tx, invariantNow(ctx))
                : s.reconcile(tx, invariantNow(ctx)),
            )) as NonNullable<typeof h.run>,
        }
      : h,
  );
  const assembly: Assembly = {
    ...base,
    timerHandlers,
    recurringJobs,
    invariants,
    timerHandler: (kind) => timerHandlers.find((h) => h.kind === kind),
    recurringJob: (kind) => recurringJobs.find((h) => h.kind === kind),
    invariant: (code) => invariants.find((h) => h.code === code),
  };
  return {
    assembly,
    attach(value: PublishPatrol) {
      if (closed || current) throw new TypeError("巡检运行时只能绑定一次");
      current = value;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      current = undefined;
    },
  };
}
