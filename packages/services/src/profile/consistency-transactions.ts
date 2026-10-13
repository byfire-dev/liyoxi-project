import { AsyncLocalStorage } from "node:async_hooks";
import type { Tx, TxRunner } from "../kernel/index.js";

/** 仅承接profile系统一致性提交后通知；原runner仍独占事务、重试、幂等和锁。 */
export function createProfileConsistencyTransactions(base: TxRunner, failed: () => void) {
  type Attempt = { admitted: boolean; effects: Array<() => Promise<void>> };
  const attempts = new WeakMap<Tx, Attempt>(),
    pending = new Set<Promise<unknown>>();
  const notifications = new AsyncLocalStorage<boolean>();
  let closed = false,
    closing: Promise<void> | undefined;
  const logFailure = () => {
    try {
      failed();
    } catch {
      /* 日志故障不改变已提交结果。 */
    }
  };
  const tx: TxRunner = {
    run(fn, options) {
      const admitted = !closed;
      const running = (async () => {
        let committed: Attempt | undefined;
        const result = await base.run(async (handle) => {
          const attempt: Attempt = { admitted, effects: [] };
          attempts.set(handle, attempt);
          try {
            const result = await fn(handle);
            committed = attempt;
            return result;
          } finally {
            attempts.delete(handle);
          }
        }, options);
        // 只取真正成功提交的最后一次attempt；失败尝试与幂等重放均没有通知。
        for (const effect of options?.idem?.replayed ? [] : (committed?.effects ?? [])) {
          try {
            await notifications.run(true, effect);
          } catch {
            logFailure();
          }
        }
        return result;
      })();
      if (!notifications.getStore()) {
        pending.add(running);
        void running.then(
          () => pending.delete(running),
          () => pending.delete(running),
        );
      }
      return running;
    },
  };
  return {
    tx,
    failed: logFailure,
    afterCommit(handle: Tx, effect: () => Promise<void>) {
      const attempt = attempts.get(handle);
      if (!attempt?.admitted) throw new TypeError("资质一致性通知必须属于本实例开放的事务");
      attempt.effects.push(effect);
    },
    close() {
      closed = true;
      return (closing ??= Promise.allSettled([...pending]).then(() => undefined));
    },
  };
}
export type ProfileConsistencyTransactions = ReturnType<
  typeof createProfileConsistencyTransactions
>;
