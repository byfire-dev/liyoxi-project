// 内部共用的原有界传输核心；不暴露为HTTP输入口，不重试，不改变原关闭与熔断语义。
import { AppError, assertNotInTransaction } from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
export const CLIENT_ERROR_MAX_BYTES = 200 * 1024;
export const CLIENT_ERROR_QUEUE_SIZE = 200;
const CONCURRENCY = 2;
const CALL_TIMEOUT_MS = 2_000;
const FAILURE_WINDOW_MS = 10_000;
const BREAKER_MS = 60_000;
export interface ErrorTransportLogger {
  info(fields: Record<string, unknown>, message: string): void;
}
export interface ErrorTransportOptions {
  readonly clock: Clock;
  readonly logger: ErrorTransportLogger;
  readonly fetch?: typeof fetch;
}
export interface Destination {
  readonly dsn: string;
  readonly endpoint: string;
  readonly auth: string;
}
interface Pending {
  readonly destination: Destination;
  readonly body: string;
}
export interface ErrorTransportSnapshot {
  readonly queued: number;
  readonly active: number;
  readonly accepted: number;
  readonly forwarded: number;
  readonly failed: number;
  readonly dropped: number;
  readonly breakerOpen: boolean;
  readonly closed: boolean;
}
export interface ErrorTransport {
  enqueue(destination: Destination | undefined, build?: () => string): void;
  drain(): Promise<void>;
  close(): Promise<void>;
  snapshot(): ErrorTransportSnapshot;
}
export function errorDestination(dsn: string): Destination {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new AppError("VALIDATION_FAILED", { message: "错误上报信封不合规" });
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-zA-Z0-9_-]+$/.test(url.username) ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*\d+$/.test(url.pathname) ||
    dsn.includes("\\")
  ) {
    throw new AppError("VALIDATION_FAILED", { message: "错误上报信封不合规" });
  }
  const slash = url.pathname.lastIndexOf("/");
  const prefix = url.pathname.slice(0, slash);
  const project = url.pathname.slice(slash + 1);
  return {
    dsn,
    endpoint: `${url.origin}${prefix}/api/${project}/envelope/`,
    auth: `Sentry sentry_version=7, sentry_key=${url.username}`,
  };
}

export function createErrorTransport(options: ErrorTransportOptions): ErrorTransport {
  const send = options.fetch ?? fetch;
  const queue: Pending[] = [];
  const active = new Set<AbortController>();
  const waiters = new Set<() => void>();
  let closed = false;
  let scheduled = false;
  let accepted = 0;
  let forwarded = 0;
  let failed = 0;
  let dropped = 0;
  let breakerUntil = 0;
  let failures: number[] = [];
  const now = () => options.clock.now().getTime();
  const breakerOpen = () => now() < breakerUntil;
  const snapshot = (): ErrorTransportSnapshot => ({
    queued: queue.length,
    active: active.size,
    accepted,
    forwarded,
    failed,
    dropped,
    breakerOpen: breakerOpen(),
    closed,
  });
  const log = (fields: Record<string, unknown>) => {
    // 监控本身不能制造新的错误循环；字段只有计数/状态，不含信封或任何 DSN。
    try {
      options.logger.info({ evt: "telemetry.forward", ...fields }, "错误上报转发");
    } catch {
      /* 日志落点失效时仍受理。 */
    }
  };
  const interval = setInterval(() => log({ outcome: "summary", ...snapshot() }), 60_000);
  interval.unref();

  function settled(): void {
    if (queue.length || active.size) return;
    for (const done of waiters) done();
    waiters.clear();
  }
  function failure(): void {
    failed += 1;
    dropped += 1;
    const at = now();
    failures = failures.filter((one) => one >= at - FAILURE_WINDOW_MS);
    failures.push(at);
    if (!breakerOpen() && failures.length >= 5) {
      breakerUntil = at + BREAKER_MS;
      failures = [];
      dropped += queue.length;
      queue.length = 0;
    }
  }
  async function forward(item: Pending, controller: AbortController): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("错误上报外呼已取消"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    });
    try {
      assertNotInTransaction("clientErrors.forward");
      const attempt = (async () => {
        const response = await send(item.destination.endpoint, {
          method: "POST",
          body: item.body,
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
          headers: {
            "content-type": "application/x-sentry-envelope",
            "x-sentry-auth": item.destination.auth,
          },
        });
        // 不读取上游错误正文；取消响应流，避免无界内容和连接占用。
        await response.body?.cancel();
        if (!response.ok) throw new Error("错误上报上游拒绝");
      })();
      await Promise.race([attempt, cancelled]);
      forwarded += 1;
    } catch {
      if (closed) dropped += 1;
      else failure();
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      active.delete(controller);
      schedule();
      settled();
    }
  }
  function pump(): void {
    scheduled = false;
    if (closed || breakerOpen()) return settled();
    while (active.size < CONCURRENCY && queue.length) {
      const item = queue.shift()!;
      const controller = new AbortController();
      active.add(controller);
      void forward(item, controller);
    }
    settled();
  }
  function schedule(): void {
    if (scheduled || closed || !queue.length) return;
    scheduled = true;
    queueMicrotask(pump);
  }
  const drain = (): Promise<void> => {
    if (!queue.length && !active.size) return Promise.resolve();
    return new Promise((resolve) => waiters.add(resolve));
  };
  return {
    enqueue(destination, build) {
      assertNotInTransaction("clientErrors.accept");
      accepted += 1;
      if (closed || breakerOpen() || !build) {
        dropped += 1;
        return;
      }
      if (!destination) {
        log({ outcome: "unconfigured" });
        return;
      }
      if (queue.length >= CLIENT_ERROR_QUEUE_SIZE) {
        dropped += 1;
        return;
      }
      const body = build();
      if (Buffer.byteLength(body) > CLIENT_ERROR_MAX_BYTES) {
        dropped += 1;
        return;
      }
      queue.push({ destination, body });
      schedule();
    },
    drain,
    async close() {
      if (!closed) {
        closed = true;
        clearInterval(interval);
        dropped += queue.length;
        queue.length = 0;
        for (const controller of active) controller.abort();
        settled();
      }
      await drain();
    },
    snapshot,
  };
}
