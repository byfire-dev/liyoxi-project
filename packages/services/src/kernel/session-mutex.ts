import { createHash } from "node:crypto";
import type { SessionMutexConnection, SessionMutexConnectionFactory } from "@liyoxi/db";
import { isInTransaction, KernelViolation } from "./tx.js";
import {
  assertSessionMutexContext,
  assertSessionMutexScope,
  currentSessionMutex,
  withSessionMutex,
} from "./session-mutex-state.js";
import type { SessionMutexState } from "./session-mutex-state.js";

export type SessionMutexFailure = "occupied" | "capacity" | "lost" | "closed" | "released";
export class SessionMutexError extends Error {
  constructor(
    readonly reason: SessionMutexFailure,
    options?: ErrorOptions,
  ) {
    super(`会话互斥不可用：${reason}`, options);
    this.name = "SessionMutexError";
  }
}
export interface SessionMutexScope {
  readonly signal: AbortSignal;
  /** 真实查询专用会话仍持锁；不提供底层连接或任意SQL能力。 */
  assertHeld(): Promise<void>;
}
export interface SessionMutex {
  run<T>(
    key: string,
    fn: (scope: SessionMutexScope) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
  close(): Promise<void>;
}
const hashKey = (key: string) =>
  createHash("sha256").update(`lyx:session-mutex:v1:${key}`).digest().readBigInt64BE();
/** 占用即拒绝；一把锁一条专用会话，业务两TX仍只经原tx.run。 */
export function createSessionMutex(options: {
  connect: SessionMutexConnectionFactory;
  maxConcurrent?: number;
  probeMs?: number;
}): SessionMutex {
  const max = options.maxConcurrent ?? 2,
    probeMs = options.probeMs ?? 1000;
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(probeMs) || probeMs < 1)
    throw new RangeError("会话互斥预算不合法");
  const active = new Set<AbortController>(),
    pending = new Set<Promise<unknown>>(),
    cleanupErrors: unknown[] = [];
  let closing: Promise<void> | undefined,
    stopped = false;
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  };
  return {
    async run(key, fn, input = {}) {
      if (isInTransaction())
        throw new KernelViolation("nested_transaction", "会话互斥须在业务事务之前取得");
      if (currentSessionMutex()) throw new TypeError("会话互斥作用域不能嵌套");
      if (stopped) throw new SessionMutexError("closed");
      if (typeof key !== "string" || key.length < 1 || key.length > 200)
        throw new RangeError("互斥键长度须为1至200");
      if (active.size >= max) throw new SessionMutexError("capacity");
      input.signal?.throwIfAborted();
      const controller = new AbortController();
      active.add(controller);
      const cancel = () => controller.abort(input.signal!.reason);
      input.signal?.addEventListener("abort", cancel, { once: true });
      const execute = async () => {
        let connection: SessionMutexConnection | undefined,
          timer: ReturnType<typeof setInterval> | undefined;
        let finished = false,
          checking: Promise<void> | undefined;
        const assertActive = () => {
          controller.signal.throwIfAborted();
          if (finished) throw new SessionMutexError("released");
        };
        const lost = (cause: unknown) => controller.abort(new SessionMutexError("lost", { cause }));
        const confirmHeld = async () => {
          assertActive();
          return (checking ??= (async () => {
            try {
              if (!(await connection!.isHeld())) throw new Error("专用会话未持锁");
              assertActive();
            } catch (error) {
              if (!controller.signal.aborted) lost(error);
              throw controller.signal.reason;
            }
          })().finally(() => {
            checking = undefined;
          }));
        };
        const finish = async () => {
          if (timer) clearInterval(timer);
          await checking?.catch(() => undefined);
          finished = true;
          input.signal?.removeEventListener("abort", cancel);
          try {
            await connection?.close();
          } catch (error) {
            cleanupErrors.push(error);
            throw error;
          } finally {
            controller.abort(new SessionMutexError("released"));
            active.delete(controller);
          }
        };
        try {
          connection = await options.connect(controller.signal);
          connection.lost.addEventListener("abort", () => lost(connection!.lost.reason), {
            once: true,
          });
          if (connection.lost.aborted) lost(connection.lost.reason);
          assertActive();
          if (!(await connection.tryLock(hashKey(key)))) throw new SessionMutexError("occupied");
          assertActive();
          timer = setInterval(() => {
            void confirmHeld().catch(() => undefined);
          }, probeMs);
          timer.unref();
          const state: SessionMutexState = {
            assertActive,
            assertHeld: async () => {
              assertSessionMutexScope(state);
              await confirmHeld();
              assertSessionMutexScope(state);
            },
          };
          const scope: SessionMutexScope = {
            get signal() {
              assertSessionMutexContext(state);
              return controller.signal;
            },
            assertHeld: state.assertHeld,
          };
          return await withSessionMutex(state, async () => {
            const work = track(
              Promise.resolve().then(() => {
                assertActive();
                return fn(scope);
              }),
            );
            let abort!: () => void;
            const interrupted = new Promise<never>((_resolve, reject) => {
              abort = () => reject(controller.signal.reason);
              controller.signal.addEventListener("abort", abort, { once: true });
              if (controller.signal.aborted) abort();
            });
            try {
              const result = await Promise.race([work, interrupted]);
              await state.assertHeld();
              return result;
            } finally {
              controller.signal.removeEventListener("abort", abort);
            }
          });
        } finally {
          // 先使未await的旧分支失效，再释放会话；正常结束不触发driver取消而跳过unlock。
          await finish();
        }
      };
      return track(execute());
    },
    close() {
      if (closing) return closing;
      stopped = true;
      for (const controller of active) controller.abort(new SessionMutexError("closed"));
      return (closing = Promise.allSettled([...pending]).then(() => {
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "互斥连接关闭失败");
      }));
    },
  };
}
