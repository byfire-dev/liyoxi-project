// W2-18：错误信封只进有界内存队列，不进业务事务；上游只来自 FILE 配置的固定映射。
import { AppError, assertNotInTransaction } from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
import { cleanClientStacktrace } from "@liyoxi/shared/telemetry";

export const CLIENT_ERROR_MAX_BYTES = 200 * 1024;
export const CLIENT_ERROR_QUEUE_SIZE = 200;
const CONCURRENCY = 2;
const CALL_TIMEOUT_MS = 2_000;
const FAILURE_WINDOW_MS = 10_000;
const BREAKER_MS = 60_000;

export interface ClientErrorProject {
  readonly dsn: string;
  readonly upstreamDsn?: string;
}

export interface ClientErrorLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface ClientErrorForwarderOptions {
  readonly clock: Clock;
  readonly logger: ClientErrorLogger;
  /** loadEnv 的 CLIENT_ERROR_PROJECTS_FILE 内容；空数组表示整个能力未配置。 */
  readonly projects: readonly ClientErrorProject[];
  /** 测试只注入虚构上游；生产使用 Node fetch。 */
  readonly fetch?: typeof fetch;
}

export interface ClientErrorSnapshot {
  readonly queued: number;
  readonly active: number;
  readonly accepted: number;
  readonly forwarded: number;
  readonly failed: number;
  readonly dropped: number;
  readonly breakerOpen: boolean;
  readonly closed: boolean;
}

export interface ClientErrorForwarder {
  /** 校验、二次去敏并受理；同步返回，不等待上游。非法信封抛 VALIDATION_FAILED。 */
  accept(raw: Uint8Array | string): void;
  /** 等已受理的队列与在途请求处理完；不关闭入口。 */
  drain(): Promise<void>;
  /** 丢弃待发项，取消在途请求与周期日志，等待收尾；幂等。 */
  close(): Promise<void>;
  snapshot(): ClientErrorSnapshot;
}

type JsonObject = Record<string, unknown>;
interface Destination {
  readonly dsn: string;
  readonly endpoint: string;
  readonly auth: string;
}
interface Pending {
  readonly destination: Destination;
  readonly body: string;
}

function invalid(): never {
  // 不保留 JSON.parse / URL 的原始错误，防止原因中带原始信封或凭据。
  throw new AppError("VALIDATION_FAILED", { message: "错误上报信封不合规" });
}

const record = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function destination(dsn: string): Destination {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return invalid();
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
    return invalid();
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

// 与端上 beforeSend 相同的手机号、USCC、lyxm token、Bearer 规则；服务端另去掉结构化凭据和请求。
const PHONE = /(^|\D)1[3-9]\d{9}(?!\d)/g;
const USCC = /(^|[^0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/g;
const TOKEN = /lyx[maps]_[A-Za-z0-9._-]+/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_TEXT =
  /\b(token|password|secret|authorization|cookie|paySign|inviteCode|apiKey|accessKey|credential)["']?\s*[=:]\s*["']?[^\s,;"'}]+/gi;

function scrubText(value: string): string {
  return value
    .replace(TOKEN, "[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(JWT, "[redacted]")
    .replace(SECRET_TEXT, "$1=[redacted]")
    .replace(USCC, "$1[redacted]")
    .replace(PHONE, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted-url]";
      }
    })
    .slice(0, 2_000);
}

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (
    /token|password|secret|authorization|cookie|phone|email|credential|passphrase|session/.test(
      normalized,
    ) ||
    [
      "request",
      "body",
      "data",
      "headers",
      "dsn",
      "idno",
      "licenseno",
      "uscc",
      "paysign",
      "code",
      "invitecode",
      "invitationcode",
      "openid",
      "unionid",
      "ipaddress",
      "apikey",
      "accesskey",
      "privatekey",
      "key",
      "vars",
      "localvariables",
      "debugmeta",
      "proto",
      "constructor",
      "prototype",
    ].includes(normalized)
  );
}

function scrub(value: unknown, depth = 0, component?: unknown): unknown {
  if (depth > 32) return invalid();
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number") {
    const text = String(value);
    return scrubText(text) === text ? value : "[redacted]";
  }
  if (Array.isArray(value)) return value.map((one) => scrub(one, depth + 1, component));
  if (!record(value)) return value;
  const result: JsonObject = Object.create(null) as JsonObject;
  for (const [key, one] of Object.entries(value)) {
    if (sensitiveKey(key)) continue;
    if (key === "user") {
      if (record(one) && typeof one.id === "string") result.user = { id: scrubText(one.id) };
      continue;
    }
    if (key === "stacktrace") {
      const safe = cleanClientStacktrace(scrub(one, depth + 1, component), component);
      if (safe) result.stacktrace = safe;
      continue;
    }
    result[scrubText(key)] = scrub(one, depth + 1, component);
  }
  return result;
}

interface Parsed {
  readonly dsn: string;
  readonly header: JsonObject;
  readonly event?: JsonObject;
}

/** 字节游标遵守 length；二进制附件可含换行，但绝不被转发或记日志。 */
function parseEnvelope(raw: Uint8Array | string): Parsed {
  const size = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (size === 0 || size > CLIENT_ERROR_MAX_BYTES) return invalid();
  const bytes =
    typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, size);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = 0;
  function json(part: Uint8Array): JsonObject {
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(part));
    } catch {
      return invalid();
    }
    if (!record(value)) return invalid();
    return value;
  }
  function line(): Uint8Array {
    const end = bytes.indexOf(10, cursor);
    if (end < 0 || end === cursor) return invalid();
    const part = bytes.subarray(cursor, end);
    cursor = end + 1;
    return part;
  }
  const header = json(line());
  if (typeof header.dsn !== "string") return invalid();
  destination(header.dsn);
  if (
    header.event_id !== undefined &&
    (typeof header.event_id !== "string" || !/^[a-f0-9]{32}$/i.test(header.event_id))
  ) {
    return invalid();
  }
  let event: JsonObject | undefined;
  let count = 0;
  while (cursor < size) {
    const item = json(line());
    if (typeof item.type !== "string" || !item.type) return invalid();
    let end: number;
    if (Object.hasOwn(item, "length")) {
      if (typeof item.length !== "number" || !Number.isSafeInteger(item.length) || item.length < 0)
        return invalid();
      end = cursor + item.length;
      if (end > size) return invalid();
    } else {
      const newline = bytes.indexOf(10, cursor);
      end = newline < 0 ? size : newline;
    }
    const payload = bytes.subarray(cursor, end);
    cursor = end;
    if (cursor < size) {
      if (bytes[cursor] !== 10) return invalid();
      cursor += 1;
    }
    count += 1;
    if (item.type !== "event") continue;
    if (event) return invalid(); // Sentry 每封最多一个 error event；不采集 transaction/附件。
    const value = json(payload);
    if (
      value.event_id !== undefined &&
      (typeof value.event_id !== "string" || !/^[a-f0-9]{32}$/i.test(value.event_id))
    )
      return invalid();
    if (
      value.event_id !== undefined &&
      header.event_id !== undefined &&
      value.event_id !== header.event_id
    )
      return invalid();
    event = scrub(value, 0, value.dist) as JsonObject;
  }
  if (count === 0) return invalid();
  const cleanHeader: JsonObject = Object.create(null) as JsonObject;
  if (header.event_id !== undefined) cleanHeader.event_id = header.event_id;
  return { dsn: header.dsn, header: cleanHeader, ...(event ? { event } : {}) };
}

export function createClientErrorForwarder(
  options: ClientErrorForwarderOptions,
): ClientErrorForwarder {
  if (options.projects.length > 3) throw new TypeError("错误上报项目配置不合规");
  const projects = new Map<string, Destination | undefined>();
  for (const project of options.projects) {
    destination(project.dsn);
    if (projects.has(project.dsn)) throw new TypeError("错误上报项目配置不合规");
    projects.set(
      project.dsn,
      project.upstreamDsn === undefined ? undefined : destination(project.upstreamDsn),
    );
  }
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
  const snapshot = (): ClientErrorSnapshot => ({
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
    accept(raw) {
      assertNotInTransaction("clientErrors.accept");
      const parsed = parseEnvelope(raw);
      if (projects.size && !projects.has(parsed.dsn)) return invalid();
      accepted += 1;
      if (closed || breakerOpen() || !parsed.event) {
        dropped += 1;
        return;
      }
      const upstream = projects.get(parsed.dsn);
      if (!upstream) {
        log({ outcome: "unconfigured" });
        return;
      }
      if (queue.length >= CLIENT_ERROR_QUEUE_SIZE) {
        dropped += 1;
        return;
      }
      const payload = JSON.stringify(parsed.event);
      const body = `${JSON.stringify({ ...parsed.header, dsn: upstream.dsn, sent_at: options.clock.now().toISOString() })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}\n`;
      if (Buffer.byteLength(body) > CLIENT_ERROR_MAX_BYTES) {
        dropped += 1;
        return;
      }
      queue.push({ destination: upstream, body });
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
