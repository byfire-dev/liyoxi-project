import { handleAdReturnedStale } from "../ad/index.js";
import type { Assembly, FiredTimer, Tx } from "../kernel/index.js";

export type AdTimerBinding = Parameters<typeof handleAdReturnedStale>[1];

/** Each API/worker instance owns its timer dependency closure and shutdown fence. */
export function createAdAssembly(base: Assembly) {
  if (base.timerHandlers.filter((item) => item.kind === "ad.returned_stale").length !== 1)
    throw new TypeError("广告待补充到期需要唯一处理器登记");
  let deps: AdTimerBinding | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const assertOpen = () => {
    if (closed || !deps) throw new TypeError("本广告定时器运行时尚未绑定或已经关闭");
  };
  const handle = (tx: Tx, timer: FiredTimer) => {
    assertOpen();
    const current = deps!;
    const active = handleAdReturnedStale(tx, current, timer).then((result) => {
      // The caller still owns its transaction. Closing during domain IO must reject before commit.
      assertOpen();
      return result;
    });
    pending.add(active);
    void active.finally(() => pending.delete(active)).catch(() => undefined);
    return active;
  };
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "ad.returned_stale" ? { ...item, handle } : item,
  );
  const index = new Map(timerHandlers.map((item) => [item.kind, item]));
  const assembly: Assembly = {
    ...base,
    timerHandlers,
    timerHandler: (kind) => index.get(kind),
  };
  return {
    assembly,
    attach(value: AdTimerBinding) {
      if (closed || deps) throw new TypeError("广告定时器运行时只能绑定一次");
      deps = { clock: value.clock, events: value.events };
    },
    close() {
      closed = true;
      return (closing ??= Promise.allSettled([...pending]).then(() => {
        deps = undefined;
      }));
    },
  };
}
