// 十二个替身共用的底座：记录调用、注入失败与延迟、跟随可拨时钟（W0-19 任务书 第 10 节第 5 项）。
//
// 时钟：替身只用到 now()。W0-05b 的可拨时钟可以直接传进来；不传就用系统时间。
// 延迟：被延迟的调用在发起时就已经生效（外部侧已经收到并处理了），只是应答晚到。
//       拨动时钟之后调 tick()，到点的应答才放行。
// 失败：注入的失败不生效（外部侧没有处理），直接返回 { ok: false }。
// 通知受理证明独立于本地 sent 记录：未知应答被取消仍不能证明未受理。

import { failed, notificationFailed } from "../../providers/types.js";
import type {
  NotificationFailureDetail,
  NotificationProviderResult,
  NotificationProviderFailure,
  ProviderFailureReason,
  ProviderLogger,
  ProviderResult,
} from "../../providers/types.js";

export interface FakeClock {
  now(): Date;
}

export const systemClock: FakeClock = { now: () => new Date() };

export interface FakeCall<M extends string = string> {
  method: M;
  input: unknown;
  at: Date;
}

export interface FakeControl<M extends string> {
  /** 调用记录，按发生的先后。注入了失败、延迟的调用也记 */
  readonly calls: Array<FakeCall<M>>;
  /** 某个方法的调用记录 */
  callsOf(method: M): Array<FakeCall<M>>;
  /** 让某个方法接下来的调用失败。缺省一次，reason 为 unavailable */
  failNext(
    method: M,
    failure?: { reason?: ProviderFailureReason; message?: string; times?: number },
  ): void;
  /** 让某个方法接下来的调用晚 ms 毫秒才应答（按替身的时钟），缺省一次。到点后调 tick() 放行 */
  delayNext(method: M, ms: number, options?: { times?: number }): void;
  /** 放行到点的应答，返回放行了几个 */
  tick(): number;
  /** 还压着没应答的调用数 */
  pendingCalls(): number;
  /** 清空调用记录与还没用掉的失败、延迟。压着的应答不动 */
  resetCalls(): void;
}

/** 只由通知发送替身公开；failNext 的旧通用失败仍不带受理证明。 */
export interface FakeNotificationControl<M extends string> {
  failNotificationNext(
    method: M,
    detail: NotificationFailureDetail,
    options?: { reason?: ProviderFailureReason; message?: string; times?: number },
  ): void;
}

interface Held {
  dueAt: number;
  release(): void;
}

export interface FakeCore<M extends string> {
  control: FakeControl<M>;
  notificationControl: FakeNotificationControl<M>;
  /** 每个方法的入口都经它：记调用，套上注入的失败与延迟，再执行 action */
  run<T>(
    method: M,
    input: unknown,
    action: () => ProviderResult<T> | Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>>;
  runNotification<T>(
    method: M,
    input: unknown,
    action: () => NotificationProviderResult<T> | Promise<NotificationProviderResult<T>>,
    signal?: AbortSignal,
  ): Promise<NotificationProviderResult<T>>;
}

export function createFakeCore<M extends string>(
  clock: FakeClock,
  notificationMethods: readonly M[] = [],
): FakeCore<M> {
  const calls: Array<FakeCall<M>> = [];
  const failures = new Map<M, NotificationProviderFailure[]>();
  const delays = new Map<M, number[]>();
  const held: Held[] = [];

  function run<T>(
    method: M,
    input: unknown,
    action: () => ProviderResult<T> | Promise<ProviderResult<T>>,
    signal?: AbortSignal,
  ): Promise<ProviderResult<T>> {
    calls.push({ method, input, at: clock.now() });
    if (signal?.aborted)
      return Promise.resolve(
        notificationFailed("rejected", "通知调用开始前已取消", {
          acceptance: "not_accepted",
          code: "aborted",
        }),
      );
    const failure = failures.get(method)?.shift();
    const delayMs = delays.get(method)?.shift();
    let outcome: Promise<ProviderResult<T>>;
    let mayHaveBeenAccepted = false;
    if (failure !== undefined) {
      mayHaveBeenAccepted = failure.notification?.acceptance !== "not_accepted";
      outcome = Promise.resolve(failure);
    } else {
      mayHaveBeenAccepted = true;
      // action 在发起调用的当下同步执行：返回之前外部侧的状态已经变了
      try {
        outcome = Promise.resolve(action());
      } catch (error) {
        outcome = Promise.reject(error);
      }
    }
    if (delayMs === undefined && signal === undefined) return outcome;
    // 应答压住期间 action 抛的错（用例写错了），留到放行时再报，不变成未处理的拒绝
    outcome.catch(() => {});
    return new Promise((resolve, reject) => {
      let settled = false;
      let item: Held | undefined;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        if (item !== undefined && held.includes(item)) held.splice(held.indexOf(item), 1);
      };
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const release = () =>
        void outcome.then(
          (result) => finish(() => resolve(result)),
          (error: unknown) => finish(() => reject(error)),
        );
      const onAbort = () =>
        finish(() =>
          resolve(
            notificationFailed(mayHaveBeenAccepted ? "unavailable" : "rejected", "通知调用已取消", {
              acceptance: mayHaveBeenAccepted ? "unknown" : "not_accepted",
              code: "aborted",
            }),
          ),
        );
      if (delayMs !== undefined) {
        item = {
          dueAt: clock.now().getTime() + delayMs,
          release,
        };
        held.push(item);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (delayMs === undefined) release();
    });
  }

  const control: FakeControl<M> = {
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method),
    failNext(method, failure = {}) {
      const { reason = "unavailable", message = "替身注入的失败", times = 1 } = failure;
      const queue = failures.get(method) ?? [];
      for (let index = 0; index < times; index += 1) queue.push(failed(reason, message));
      failures.set(method, queue);
    },
    delayNext(method, ms, options = {}) {
      const queue = delays.get(method) ?? [];
      for (let index = 0; index < (options.times ?? 1); index += 1) queue.push(ms);
      delays.set(method, queue);
    },
    tick() {
      const now = clock.now().getTime();
      const due = held.filter((item) => item.dueAt <= now);
      for (const item of due) {
        held.splice(held.indexOf(item), 1);
        item.release();
      }
      return due.length;
    },
    pendingCalls: () => held.length,
    resetCalls() {
      calls.length = 0;
      failures.clear();
      delays.clear();
    },
  };

  const notificationControl: FakeNotificationControl<M> = {
    failNotificationNext(method, detail, options = {}) {
      if (!notificationMethods.includes(method)) throw new TypeError("不是通知发送方法");
      const { reason = "rejected", message = "替身注入的通知失败", times = 1 } = options;
      if (!Number.isSafeInteger(times) || times < 1 || times > 1000)
        throw new TypeError("通知失败注入次数不合法");
      const outcome = notificationFailed(reason, message, detail);
      const queue = failures.get(method) ?? [];
      for (let index = 0; index < times; index += 1) queue.push(outcome);
      failures.set(method, queue);
    },
  };
  return {
    control,
    run: (method, input, action) => run(method, input, action),
    notificationControl,
    runNotification: (method, input, action, signal) => {
      if (!notificationMethods.includes(method)) throw new TypeError("不是通知发送方法");
      return run(method, input, action, signal);
    },
  };
}

export interface RecordedLog {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

/** 把日志记在内存里的 logger：用例拿它断言启动日志 */
export function createRecordingLogger(): ProviderLogger & { readonly lines: RecordedLog[] } {
  const lines: RecordedLog[] = [];
  const at = (level: RecordedLog["level"]) => (fields: Record<string, unknown>, message: string) =>
    void lines.push({ level, fields, message });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}
