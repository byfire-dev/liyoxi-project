import { AsyncLocalStorage } from "node:async_hooks";
/** 只在kernel内流转；tx捕获原作用域，不能借兄弟链的锁继续写。 */
export interface SessionMutexState {
  assertActive(): void;
  assertHeld(): Promise<void>;
}
const scopes = new AsyncLocalStorage<SessionMutexState>();
export const currentSessionMutex = () => scopes.getStore();
export const withSessionMutex = <T>(state: SessionMutexState, run: () => Promise<T>): Promise<T> =>
  scopes.run(state, run);
export function assertSessionMutexContext(expected: SessionMutexState | undefined): void {
  if (expected !== currentSessionMutex()) throw new TypeError("会话互斥作用域不能跨异步链复用");
}
export function assertSessionMutexScope(expected: SessionMutexState | undefined): void {
  assertSessionMutexContext(expected);
  expected?.assertActive();
}
