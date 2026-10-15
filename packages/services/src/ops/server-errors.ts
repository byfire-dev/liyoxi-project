// 服务端自身出口；HTTP客户端信封不经过这里。原始stack只用于提取固定自有dist坐标，不发送。
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LOOPS, QUEUES } from "@liyoxi/contract/registry";
import type { Clock } from "../kernel/index.js";
import { scrubErrorText } from "./client-errors.js";
import { createErrorTransport, errorDestination } from "./error-transport.js";
import type {
  ErrorTransport,
  ErrorTransportLogger,
  ErrorTransportSnapshot,
} from "./error-transport.js";

const summaries = {
  "api.5xx": "API request failed",
  "worker.loop": "Worker loop failed",
  "worker.queue": "Worker queue handler failed",
  "worker.delivery.retry": "Outbox delivery scheduled for retry",
  "worker.delivery.dead": "Outbox delivery exhausted attempts",
  "worker.timer.retry": "Timer scheduled for retry",
  "worker.timer.failed": "Timer exhausted attempts",
  "process.uncaught": "Uncaught process exception",
  "process.unhandled": "Unhandled process rejection",
  "process.start": "Process startup failed",
  "process.close": "Process shutdown failed",
} as const;
export type ServerErrorKind = keyof typeof summaries;
export interface ServerErrorReporter {
  capture(error: unknown, kind: ServerErrorKind, scope?: string): void;
  drain(): Promise<void>;
  close(): Promise<void>;
  snapshot(): ErrorTransportSnapshot;
}
export interface ServerErrorOptions {
  readonly component: "api" | "worker";
  readonly release: string;
  /** 仅进程装配注入import.meta.url的自有dist目录，不能来自请求或配置文件。 */
  readonly artifactRoot?: URL;
  readonly dsn?: string;
  readonly clock: Clock;
  readonly logger: ErrorTransportLogger;
  readonly fetch?: typeof fetch;
}
const scopes = new Set<string>([...LOOPS.map((one) => one.id), ...QUEUES.map((one) => one.id)]);
const files = {
  api: new Set(["server.js", "check-env.js", "document-converter.js"]),
  worker: new Set([
    "index.js",
    "redis-compat.js",
    "seed.js",
    "staff-bootstrap.js",
    "staff-reissue-activation.js",
    "sms-init.js",
    "alerts-ack.js",
    "analytics-repartition.js",
    "document-converter.js",
  ]),
};
function frames(error: unknown, options: ServerErrorOptions) {
  if (!(error instanceof Error) || !options.artifactRoot) return [];
  const root = options.artifactRoot;
  if (root.protocol !== "file:" || root.search || root.hash || !root.pathname.endsWith("/"))
    return [];
  const prefix = fileURLToPath(root);
  const result: {
    filename: string;
    abs_path: string;
    lineno: number;
    colno: number;
    in_app: true;
  }[] = [];
  const stack = error.stack;
  if (typeof stack !== "string" || stack.length > 32_768) return [];
  for (const line of stack.split("\n").slice(0, 100)) {
    const match = /^\s*at (?:[A-Za-z0-9_.$<>[\]-]+ \()?([^()]+):(\d{1,10}):(\d{1,10})\)?$/.exec(
      line,
    );
    if (!match) continue;
    const raw = match[1]!,
      row = Number(match[2]),
      column = Number(match[3]);
    if (/[%\\?#\s]/.test(raw) || raw.split("/").some((one) => one === "." || one === ".."))
      continue;
    const path = raw.startsWith(prefix)
      ? raw.slice(prefix.length)
      : raw.startsWith(root.href)
        ? raw.slice(root.href.length)
        : "";
    if (
      (!files[options.component].has(path) &&
        !(options.component === "api" && /^chunk-[A-Z0-9]{8}\.js$/.test(path))) ||
      scrubErrorText(path) !== path ||
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row <= 0 ||
      column <= 0 ||
      row > 2_147_483_647 ||
      column > 2_147_483_647
    )
      continue;
    result.push({
      filename: path,
      abs_path: `app:///${options.component}/${path}`,
      lineno: row,
      colno: column,
      in_app: true,
    });
    if (result.length === 50) break;
  }
  return result.reverse();
}

export function createServerErrorReporter(options: ServerErrorOptions): ServerErrorReporter {
  const destination = options.dsn === undefined ? undefined : errorDestination(options.dsn);
  let transport: ErrorTransport | undefined;
  let closed = false;
  return {
    drain: () => transport?.drain() ?? Promise.resolve(),
    close: () => {
      closed = true;
      return transport?.close() ?? Promise.resolve();
    },
    snapshot: () =>
      transport?.snapshot() ?? {
        queued: 0,
        active: 0,
        accepted: 0,
        forwarded: 0,
        failed: 0,
        dropped: 0,
        breakerOpen: false,
        closed,
      },
    capture(error, kind, scope) {
      // 监控本身不抛、不递归；仅固定摘要，Error.message/SQL/details/cause都不进入信封。
      try {
        if (closed || !destination || !Object.hasOwn(summaries, kind)) return;
        const release = options.release;
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release) ||
          scrubErrorText(release) !== release
        )
          return;
        const at = options.clock.now(),
          id = randomUUID().replaceAll("-", "");
        const trace = frames(error, options);
        const type =
          error instanceof TypeError
            ? "TypeError"
            : error instanceof RangeError
              ? "RangeError"
              : error instanceof ReferenceError
                ? "ReferenceError"
                : error instanceof SyntaxError
                  ? "SyntaxError"
                  : "Error";
        const event = {
          event_id: id,
          timestamp: at.getTime() / 1_000,
          platform: "node",
          level: kind.startsWith("process.") ? "fatal" : "error",
          release,
          dist: options.component,
          tags: { kind, ...(scope && scopes.has(scope) ? { scope } : {}) },
          exception: {
            values: [
              {
                type,
                value: summaries[kind],
                ...(trace.length ? { stacktrace: { frames: trace } } : {}),
              },
            ],
          },
        };
        (transport ??= createErrorTransport(options)).enqueue(destination, () => {
          const payload = JSON.stringify(event);
          return `${JSON.stringify({ event_id: id, dsn: destination.dsn, sent_at: at.toISOString() })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}\n`;
        });
      } catch {
        /* 保持原日志与业务结果；不把监控错误递归送给自己。 */
      }
    },
  };
}

/** caught终止与fatal共用；先有界排已受理信封，再由原资源所有者close。未配立即完成。 */
export async function drainServerErrors(reporter?: ServerErrorReporter): Promise<void> {
  if (!reporter) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => reporter.drain())
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 入口私有监听：异常不恢复继续运行；重复异常共用一次退出，最长2秒，监听只归本实例。 */
export function installServerErrorHandlers(options: {
  readonly reporter: ServerErrorReporter;
  readonly log: (error: unknown, kind: "process.uncaught" | "process.unhandled") => void;
  readonly target?: {
    on(
      event: "uncaughtException" | "unhandledRejection",
      listener: (error: unknown) => void,
    ): unknown;
    off(
      event: "uncaughtException" | "unhandledRejection",
      listener: (error: unknown) => void,
    ): unknown;
  };
  readonly exit?: (code: number) => void;
}) {
  const target = options.target ?? process,
    exit = options.exit ?? ((code) => process.exit(code));
  let running: Promise<void> | undefined;
  const fatal = (error: unknown, kind: "process.uncaught" | "process.unhandled") =>
    (running ??= Promise.resolve().then(async () => {
      try {
        options.log(error, kind);
      } catch {
        /* 日志失败不能阻止原非零退出。 */
      }
      try {
        options.reporter.capture(error, kind);
      } catch {
        /* 旁路失败仍退出。 */
      }
      try {
        await drainServerErrors(options.reporter);
      } finally {
        void Promise.resolve()
          .then(() => options.reporter.close())
          .catch(() => undefined);
        exit(1);
      }
    }));
  const uncaught = (error: unknown) => {
    void fatal(error, "process.uncaught");
  };
  const unhandled = (error: unknown) => {
    void fatal(error, "process.unhandled");
  };
  target.on("uncaughtException", uncaught);
  target.on("unhandledRejection", unhandled);
  return Object.assign(
    () => {
      target.off("uncaughtException", uncaught);
      target.off("unhandledRejection", unhandled);
    },
    { hasFailed: () => running !== undefined },
  );
}

/** 原失败事实已提交后使用；不查库、不改变结果，也不把受控业务失败伪装为原始异常。 */
export function reportWorkerOutcome(
  reporter: ServerErrorReporter | undefined,
  source: "delivery" | "timer",
  outcome: string,
): void {
  const kind = `worker.${source}.${outcome}`;
  if (Object.hasOwn(summaries, kind)) reporter?.capture(undefined, kind as ServerErrorKind);
}
