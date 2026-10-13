import type { RecurringRunContext, SessionMutexScope, Tx, TxRunner } from "../../kernel/index.js";
import type { RetentionDeps } from "./types.js";

export const SWEEP_BATCH = 100;
export function sweepContext(deps: RetentionDeps, context: RecurringRunContext) {
  if (!context.signal || !context.runTx || !deps.retention?.sweep)
    throw new TypeError("media.sweep需要真实job租约、事务入口与完整运行时装配");
  const signal = context.signal,
    runTx = context.runTx,
    retention = deps.retention;
  const tx: TxRunner = {
    async run(fn) {
      signal.throwIfAborted();
      return runTx(async (handle) => {
        signal.throwIfAborted();
        const result = await fn(handle);
        signal.throwIfAborted();
        return result;
      });
    },
  };
  return {
    signal,
    tx,
    deps: { ...deps, tx },
    stage: <T>(name: string, fn: (scope: SessionMutexScope) => Promise<T>) => {
      signal.throwIfAborted();
      return retention.sessionMutex.run(`media:sweep:${name}`, fn, { signal });
    },
    transaction: <T>(name: string, fn: (handle: Tx) => Promise<T>) =>
      retention.sessionMutex.run(`media:sweep:${name}`, () => tx.run(fn), { signal }),
  };
}
export type SweepContext = ReturnType<typeof sweepContext>;
