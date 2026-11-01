import { handleAdReturnedStale, handleAdSlaBreach, createAdFileGuard } from "../ad/index.js";
import { fileCategoryGuardPort } from "../media/index.js";
import type { FileCategoryGuard } from "../media/index.js";
import type { Assembly, FiredTimer, Tx, KeyedPort } from "../kernel/index.js";

export type AdTimerBinding = Parameters<typeof handleAdReturnedStale>[1];

/** Each API/worker instance owns its timer dependency closure and shutdown fence. */
export function createAdAssembly(base: Assembly) {
  if (base.timerHandlers.filter((item) => item.kind === "ad.returned_stale").length !== 1)
    throw new TypeError("广告待补充到期需要唯一处理器登记");
  if (base.timerHandlers.filter((item) => item.kind === "sla.breach").length !== 1)
    throw new TypeError("广告时限需要唯一的 sla.breach 处理器");
  let deps: AdTimerBinding | undefined;
  let fileGuard: FileCategoryGuard | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const assertOpen = () => {
    if (closed || !deps) throw new TypeError("本广告定时器运行时尚未绑定或已经关闭");
  };
  const track = <T>(run: () => Promise<T>) => {
    assertOpen();
    const active = run().then((result) => {
      // The caller still owns its transaction. Closing during domain IO must reject before commit.
      assertOpen();
      return result;
    });
    pending.add(active);
    void active.finally(() => pending.delete(active)).catch(() => undefined);
    return active;
  };
  const handle = (tx: Tx, timer: FiredTimer) =>
    track(() =>
      (timer.kind === "sla.breach" ? handleAdSlaBreach : handleAdReturnedStale)(tx, deps!, timer),
    );
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "ad.returned_stale"
      ? { ...item, handle }
      : item.kind === "sla.breach"
        ? {
            ...item,
            handle: (...args: Parameters<typeof item.handle>) =>
              args[1].subjectType === "ad" ? handle(...args) : item.handle(...args),
          }
        : item,
  );
  const guard: FileCategoryGuard = {
    assert: (...args) => track(() => fileGuard!.assert(...args)),
    registered: (...args) => track(() => fileGuard!.registered!(...args)),
  };
  const index = new Map(timerHandlers.map((item) => [item.kind, item]));
  const portImplementations = base.portImplementations.map((item) =>
    item.port === fileCategoryGuardPort && item.key === "ad_video"
      ? { ...item, impl: guard }
      : item,
  );
  const assembly: Assembly = {
    ...base,
    timerHandlers,
    portImplementations,
    timerHandler: (kind) => index.get(kind),
    portEntries<T>(port: KeyedPort<T>) {
      const entries = new Map(base.portEntries(port));
      if (port === fileCategoryGuardPort) entries.set("ad_video", guard as T);
      return entries;
    },
  };
  return {
    assembly,
    attach(value: AdTimerBinding) {
      if (closed || deps) throw new TypeError("广告定时器运行时只能绑定一次");
      deps = { clock: value.clock, events: value.events };
      fileGuard = createAdFileGuard(value.clock);
    },
    close() {
      closed = true;
      return (closing ??= Promise.allSettled([...pending]).then(() => {
        deps = undefined;
        fileGuard = undefined;
      }));
    },
  };
}
