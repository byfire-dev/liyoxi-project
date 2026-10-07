// W2-18：轻量 Sentry 错误信封，不装 SDK；业务请求、响应正文和凭据不进入信封。
import type { paths as AdminPaths } from "@liyoxi/contract/types/admin";

import type { AdminApi } from "../lib/api";

export const ADMIN_ERROR_REPORTS_PER_MINUTE = 10;
export const ADMIN_ERROR_SESSION_LIMIT = 1_000;
const MAX_TEXT = 2_000;
const MAX_IN_FLIGHT = 2;
const MINUTE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /(^|\D)1[3-9]\d{9}(?!\d)/g;
const USCC = /(^|[^0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/g;
const SESSION = /lyx[maps]_[A-Za-z0-9._-]+/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET =
  /\b(token|password|secret|authorization|cookie|paySign|inviteCode|apiKey|credential)["']?\s*[=:]\s*["']?[^\s,;"'}]+/gi;

export type AdminClientErrorKind = "error" | "unhandledrejection" | "handler" | "api";
export interface AdminClientReportingOptions {
  /** 公开 DSN；空串或不合规时不发送。 */
  readonly dsn: string;
  readonly build: string;
  readonly sender: (raw: string) => Promise<unknown>;
  readonly now?: () => number;
  readonly uuid?: () => string;
  /** 当前员工的内部 UUID；匿名为 null，不接姓名/邮箱/其它 user 字段。 */
  readonly getUserId?: () => string | null;
}
export interface AdminClientReporting {
  capture(error: unknown, kind?: AdminClientErrorKind): void;
  /** 可重复安装，同一 window 只有一组监听；返回幂等解绑。 */
  install(target: Window): () => void;
}

/** 中央客户端仍负责同源cookie和统一头；显式原文序列化，不能把信封再包成JSON字符串。 */
export function createAdminClientErrorSender(client: AdminApi<AdminPaths>["client"]) {
  return (raw: string): Promise<unknown> =>
    client.POST("/api/v1/admin/client-errors", {
      body: raw,
      bodySerializer: (body) => body,
      headers: { "Content-Type": "application/x-sentry-envelope" },
    });
}

function scrub(value: string): string {
  return value
    .replace(SESSION, "[token]")
    .replace(BEARER, "Bearer [token]")
    .replace(JWT, "[token]")
    .replace(SECRET, "$1=[redacted]")
    .replace(USCC, "$1[uscc]")
    .replace(PHONE, "$1[phone]")
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
    .slice(0, MAX_TEXT);
}

function validDsn(dsn: string): boolean {
  if (!dsn || dsn.length > 2_048 || dsn.includes("\\")) return false;
  try {
    const url = new URL(dsn);
    return (
      url.protocol === "https:" &&
      /^[a-zA-Z0-9_-]+$/.test(url.username) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/(?:[a-zA-Z0-9_-]+\/)*\d+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function describe(error: unknown): { type: string; value: string; stack?: string } {
  if (error instanceof Error)
    return {
      type: scrub(error.name || "Error"),
      value: scrub(error.message),
      ...(typeof error.stack === "string" ? { stack: scrub(error.stack) } : {}),
    };
  if (typeof error === "string") return { type: "Error", value: scrub(error) };
  if (typeof error === "number" || typeof error === "boolean")
    return { type: "Error", value: scrub(String(error)) };
  if (typeof error === "object" && error !== null) {
    // 不JSON.stringify未知reason：它可能含请求体、凭据、循环引用或有副作用的getter。
    const ownMessage = Object.getOwnPropertyDescriptor(error, "message");
    if (ownMessage && typeof ownMessage.value === "string")
      return { type: "Error", value: scrub(ownMessage.value) };
  }
  return { type: "Error", value: "Unknown error" };
}

export function createAdminClientReporting(
  options: AdminClientReportingOptions,
): AdminClientReporting {
  const configured = validDsn(options.dsn);
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const seen = new Set<string>();
  const installed = new WeakMap<Window, { refs: number; remove(): void }>();
  let start: number | undefined;
  let sent = 0;
  let inFlight = 0;
  let enteringSender = false;
  const capture = (error: unknown, kind: AdminClientErrorKind = "handler"): void => {
    try {
      if (
        !configured ||
        enteringSender ||
        inFlight >= MAX_IN_FLIGHT ||
        seen.size >= ADMIN_ERROR_SESSION_LIMIT
      )
        return;
      const { type, value, stack } = describe(error);
      const fingerprint = `${kind}|${type}|${value}`;
      if (seen.has(fingerprint)) return;
      const at = now();
      if (!Number.isFinite(at)) return;
      if (start === undefined || at - start >= MINUTE_MS) {
        start = at;
        sent = 0;
      }
      if (sent >= ADMIN_ERROR_REPORTS_PER_MINUTE) return;
      const eventId = uuid().replaceAll("-", "");
      if (!/^[0-9a-f]{32}$/i.test(eventId)) return;
      const userId = options.getUserId?.();
      const event = {
        event_id: eventId,
        timestamp: at / 1_000,
        platform: "javascript",
        level: "error",
        release: scrub(options.build),
        tags: { kind, clientPlatform: "web" },
        ...(userId && UUID.test(userId) ? { user: { id: userId } } : {}),
        exception: { values: [{ type, value, ...(stack ? { stack } : {}) }] },
      };
      const raw = [
        JSON.stringify({
          event_id: eventId,
          sent_at: new Date(at).toISOString(),
          dsn: options.dsn,
        }),
        JSON.stringify({ type: "event" }),
        JSON.stringify(event),
      ].join("\n");
      seen.add(fingerprint);
      sent += 1;
      enteringSender = true;
      inFlight += 1;
      try {
        void Promise.resolve(options.sender(raw))
          .catch(() => undefined)
          .finally(() => {
            inFlight -= 1;
          });
      } catch {
        inFlight -= 1;
      } finally {
        enteringSender = false;
      }
    } catch {
      /* 上报是旁路；自己的错误不递归、不抛出、不写信封日志。 */
    }
  };
  return {
    capture,
    install(target) {
      if (!configured) return () => {};
      let entry = installed.get(target);
      if (!entry) {
        const onError = (event: ErrorEvent) =>
          capture(event.error ?? event.message ?? "Resource error", "error");
        const onRejection = (event: PromiseRejectionEvent) =>
          capture(event.reason, "unhandledrejection");
        target.addEventListener("error", onError, { capture: true });
        target.addEventListener("unhandledrejection", onRejection);
        entry = {
          refs: 0,
          remove() {
            target.removeEventListener("error", onError, { capture: true });
            target.removeEventListener("unhandledrejection", onRejection);
            installed.delete(target);
          },
        };
        installed.set(target, entry);
      }
      const active = entry;
      active.refs += 1;
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        active.refs -= 1;
        if (!active.refs) active.remove();
      };
    },
  };
}
