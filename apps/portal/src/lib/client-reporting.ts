import { clientErrorFrames } from "@liyoxi/shared/telemetry";

import type { PortalClient } from "./api";
import { createPortalErrorReporter, type PortalClientError } from "./client-errors";

export const PORTAL_ERROR_REPORTS_PER_MINUTE = 10;
export const PORTAL_ERROR_SESSION_LIMIT = 1_000;
const MAX_IN_FLIGHT = 2;
const MINUTE_MS = 60_000;
// V8 exposes Error.stack as an own native accessor, even after assigning a stack string.
// Retain only its intrinsic function, never the sample Error or any stack text.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const messages: Record<PortalClientError["category"], string> = {
  network: "Portal network request failed",
  api: "Portal API request failed",
  not_found: "Portal resource not found",
  exception: "Portal browser exception",
  unhandled_rejection: "Portal unhandled rejection",
};

export interface PortalClientReportingOptions {
  readonly client: PortalClient;
  /** Public build configuration only. No DSN means no collection or delivery. */
  readonly dsn: string;
  readonly build: string;
  readonly origin?: string;
  readonly now?: () => number;
  readonly uuid?: () => string;
}
export interface PortalClientReporting {
  report(input: unknown): void;
  capture(error: unknown, category?: "exception" | "unhandled_rejection"): void;
  install(target: Window): () => void;
  dispose(): void;
}

/** Generated request body stays raw; the central client owns same-origin Cookie and CSRF. */
export function createPortalClientErrorSender(client: PortalClient) {
  return (raw: string, signal?: AbortSignal): Promise<null> =>
    client.request("/api/v1/portal/client-errors", "post", { body: raw, signal });
}

function validDsn(dsn: string): boolean {
  if (!dsn || dsn.length > 2_048 || dsn.includes("\\")) return false;
  try {
    const url = new URL(dsn);
    return (
      url.protocol === "https:" &&
      /^[A-Za-z0-9_-]+$/.test(url.username) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/(?:[A-Za-z0-9_-]+\/)*\d+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function frames(error: unknown, origin?: string) {
  if (error === null || typeof error !== "object") return [];
  // Never read message/name/body or execute a custom stack getter.
  const stack = Object.getOwnPropertyDescriptor(error, "stack");
  const value =
    stack && "value" in stack
      ? stack.value
      : stack?.get && stack.get === nativeStackGetter
        ? stack.get.call(error)
        : undefined;
  return clientErrorFrames(value, "portal", origin);
}

/** No raw error, URL, identity, token or request body is stored in the bounded dedup set. */
export function createPortalClientReporting(
  options: PortalClientReportingOptions,
): PortalClientReporting {
  const configured = validDsn(options.dsn) && /^[A-Za-z0-9._-]{1,128}$/.test(options.build);
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const send = createPortalClientErrorSender(options.client);
  const seen = new Set<string>();
  const pending = new Set<AbortController>();
  const installed = new Map<Window, { refs: number; remove(): void }>();
  let disposed = false;
  let enteringSender = false;
  let minuteStart: number | undefined;
  let sent = 0;
  const project = createPortalErrorReporter((safe) => {
    if (
      disposed ||
      enteringSender ||
      pending.size >= MAX_IN_FLIGHT ||
      seen.size >= PORTAL_ERROR_SESSION_LIMIT
    )
      return;
    const fingerprint = JSON.stringify([safe.category, safe.status, safe.stacktrace]);
    if (seen.has(fingerprint)) return;
    const at = now();
    if (!Number.isFinite(at)) return;
    if (minuteStart === undefined || at - minuteStart >= MINUTE_MS) {
      minuteStart = at;
      sent = 0;
    }
    if (sent >= PORTAL_ERROR_REPORTS_PER_MINUTE) return;
    const eventId = uuid().replaceAll("-", "");
    if (!/^[0-9a-f]{32}$/i.test(eventId)) return;
    const event = {
      event_id: eventId,
      timestamp: at / 1_000,
      platform: "javascript",
      level: "error",
      release: options.build,
      dist: "portal",
      tags: {
        kind: safe.category,
        clientPlatform: "web",
        ...(safe.status ? { status: String(safe.status) } : {}),
        ...(safe.requestId ? { requestId: safe.requestId } : {}),
      },
      exception: {
        values: [
          {
            type: "PortalClientError",
            value: messages[safe.category],
            ...(safe.stacktrace ? { stacktrace: safe.stacktrace } : {}),
          },
        ],
      },
    };
    const raw = [
      JSON.stringify({ event_id: eventId, sent_at: new Date(at).toISOString(), dsn: options.dsn }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    const controller = new AbortController();
    seen.add(fingerprint);
    sent += 1;
    pending.add(controller);
    enteringSender = true;
    try {
      void send(raw, controller.signal)
        .catch(() => undefined)
        .finally(() => pending.delete(controller));
    } catch {
      pending.delete(controller);
    } finally {
      enteringSender = false;
    }
  });
  const report = (input: unknown) => {
    if (configured && !disposed) project(input);
  };
  const origin = () =>
    options.origin ?? (typeof location === "undefined" ? undefined : location.origin);
  const capture: PortalClientReporting["capture"] = (error, category = "exception") => {
    if (!configured || disposed) return;
    try {
      report({ category, stacktrace: { frames: frames(error, origin()) } });
    } catch {
      // Even hostile exception objects cannot break the business path.
    }
  };
  const unsubscribe = configured
    ? options.client.subscribeErrors(({ error }) => {
        try {
          report({
            category:
              error.error === "NETWORK_ERROR"
                ? "network"
                : error.status === 404
                  ? "not_found"
                  : "api",
            status: error.status,
            requestId: error.requestId,
            stacktrace: { frames: frames(error, origin()) },
          });
        } catch {
          // Do not turn a reporting failure into another client error.
        }
      })
    : () => {};
  return {
    report,
    capture,
    install(target) {
      if (!configured || disposed) return () => {};
      let entry = installed.get(target);
      if (!entry) {
        const onError = (event: ErrorEvent) => capture(event.error, "exception");
        const onRejection = (event: PromiseRejectionEvent) =>
          capture(event.reason, "unhandled_rejection");
        entry = {
          refs: 0,
          remove() {
            target.removeEventListener("error", onError, { capture: true });
            target.removeEventListener("unhandledrejection", onRejection);
            installed.delete(target);
          },
        };
        target.addEventListener("error", onError, { capture: true });
        target.addEventListener("unhandledrejection", onRejection);
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
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const entry of installed.values()) entry.remove();
      for (const controller of pending) controller.abort();
      pending.clear();
      seen.clear();
    },
  };
}
