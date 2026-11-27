import { PortalApiError, safePortalError } from "../../lib/api-errors";
import type { PortalRuntime } from "../../lib/runtime";
import { createPortalTicketFlow, type PublicPortalTicket } from "./api";

export interface PortalLoginSnapshot {
  readonly status:
    | "checking"
    | "creating"
    | "pending"
    | "exchanging"
    | "rejected"
    | "expired"
    | "consumed"
    | "authenticated"
    | "error"
    | "maintenance";
  readonly ticket: PublicPortalTicket | null;
  readonly error: PortalApiError | null;
  readonly retryAt: number | null;
}
export const initialLoginSnapshot: PortalLoginSnapshot = Object.freeze({
  status: "checking",
  ticket: null,
  error: null,
  retryAt: null,
});

/** A login leaf owns only presentation and polling; the shared shell owns authentication. */
export function createPortalLoginModel(
  runtime: Pick<PortalRuntime, "client" | "session">,
  options: { authenticated: () => void; now?: () => number },
) {
  const now = options.now ?? Date.now;
  let tickets = createPortalTicketFlow(runtime.client);
  const listeners = new Set<(snapshot: PortalLoginSnapshot) => void>();
  let snapshot = initialLoginSnapshot;
  let generation = 0;
  let disposed = false;
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: PortalLoginSnapshot) => {
    if (disposed) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener(snapshot);
  };
  const current = (revision: number) => !disposed && revision === generation;
  const stop = () => {
    clearTimeout(timer);
    controller.abort();
    tickets.dispose();
    controller = new AbortController();
    return ++generation;
  };
  const fail = (value: unknown) => {
    const error = safePortalError(value);
    publish({
      ...snapshot,
      status: error.error === "MAINTENANCE" ? "maintenance" : "error",
      error,
      retryAt: error.retryAfter === null ? null : now() + error.retryAfter * 1000,
    });
  };
  const authenticated = (revision: number) => {
    if (!current(revision)) return false;
    const session = runtime.session.getSnapshot();
    if (session.status !== "authenticated") return false;
    publish({ status: "authenticated", ticket: null, error: null, retryAt: null });
    options.authenticated();
    return true;
  };
  const poll = async (revision: number, ticket: PublicPortalTicket) => {
    if (!current(revision)) return;
    if (Date.parse(ticket.expiresAt) <= now()) {
      tickets.dispose();
      publish({ ...snapshot, status: "expired" });
      return;
    }
    try {
      const result = await tickets.poll(controller.signal);
      if (!current(revision)) return;
      if (result.status === "pending") {
        timer = setTimeout(() => void poll(revision, ticket), ticket.pollIntervalMs);
      } else if (result.status === "approved") {
        publish({ ...snapshot, status: "exchanging" });
        const exchange = await tickets.exchange(controller.signal);
        if (!current(revision)) return;
        if (exchange.status !== "consumed") {
          publish({ ...snapshot, status: "rejected" });
          return;
        }
        // A successful exchange is not a session assertion: read back the actual Secure Cookie.
        await runtime.session.load();
        if (!current(revision) || authenticated(revision)) return;
        fail(runtime.session.getSnapshot().error ?? new PortalApiError("AUTH_REQUIRED", 401));
      } else {
        publish({ ...snapshot, status: result.status });
      }
    } catch (error) {
      if (current(revision)) fail(error);
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (snapshot: PortalLoginSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (
        disposed ||
        snapshot.status === "maintenance" ||
        (snapshot.retryAt !== null && now() < snapshot.retryAt)
      )
        return;
      const revision = stop();
      tickets = createPortalTicketFlow(runtime.client);
      publish({ status: "checking", ticket: null, error: null, retryAt: null });
      try {
        await runtime.session.load();
        if (!current(revision) || authenticated(revision)) return;
        const session = runtime.session.getSnapshot();
        if (session.status !== "invalid") {
          fail(session.error ?? new PortalApiError("NETWORK_ERROR"));
          return;
        }
        publish({ ...snapshot, status: "creating" });
        const ticket = await tickets.create(controller.signal);
        if (!current(revision)) return;
        publish({ status: "pending", ticket, error: null, retryAt: null });
        timer = setTimeout(() => void poll(revision, ticket), ticket.pollIntervalMs);
      } catch (error) {
        if (current(revision)) fail(error);
      }
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      tickets.dispose();
      listeners.clear();
    },
  };
}
export type PortalLoginModel = ReturnType<typeof createPortalLoginModel>;
