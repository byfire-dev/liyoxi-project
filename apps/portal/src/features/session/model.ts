import type { PortalClient } from "../../lib/api";
import { PortalApiError, safePortalError } from "../../lib/api-errors";
import { createPortalSessionApi, type PortalSession } from "./api";

export interface PortalSessionSnapshot {
  readonly status: "unknown" | "loading" | "authenticated" | "invalid" | "error" | "maintenance";
  readonly session: PortalSession | null;
  readonly scope: string | null;
  readonly generation: number;
  readonly error: PortalApiError | null;
  readonly retryAt: number | null;
  readonly logoutPending: boolean;
}
export interface PortalScope {
  readonly key: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
export interface PortalSessionStore {
  getSnapshot(): PortalSessionSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  logout(): Promise<void>;
  invalidate(reason?: PortalApiError): void;
  captureScope(): PortalScope | null;
  dispose(): void;
}

/** Sole owner of authenticated scope; every new authorization is read back through current. */
export function createPortalSessionStore(
  client: PortalClient,
  options: { now?: () => number } = {},
): PortalSessionStore {
  const api = createPortalSessionApi(client);
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let revision = 0;
  let disposed = false;
  let scopeController = new AbortController();
  let loading: Promise<void> | null = null;
  let loggingOut: Promise<void> | null = null;
  let snapshot: PortalSessionSnapshot = Object.freeze({
    status: "unknown",
    session: null,
    scope: null,
    generation: client.getGeneration(),
    error: null,
    retryAt: null,
    logoutPending: false,
  });
  const publish = (next: PortalSessionSnapshot) => {
    if (disposed) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const clearScope = () => {
    revision += 1;
    loading = null;
    scopeController.abort();
    scopeController = new AbortController();
    return client.advanceScope();
  };
  const invalidate = (error = new PortalApiError("AUTH_REQUIRED", 401)) => {
    if (disposed || snapshot.status === "invalid") return;
    const generation = clearScope();
    publish({
      status: "invalid",
      session: null,
      scope: null,
      generation,
      error,
      retryAt: null,
      logoutPending: false,
    });
  };
  const failed = (error: PortalApiError) => {
    if (error.status === 401) {
      invalidate(error);
      return;
    }
    if (error.error === "MAINTENANCE") {
      const generation = clearScope();
      publish({
        status: "maintenance",
        session: null,
        scope: null,
        generation,
        error,
        retryAt: null,
        logoutPending: false,
      });
      return;
    }
    if (error.error === "REQUEST_ABORTED") return;
    publish({
      ...snapshot,
      status: snapshot.session ? "authenticated" : "error",
      error,
      retryAt:
        error.status === 429 && error.retryAfter !== null ? now() + error.retryAfter * 1000 : null,
      logoutPending: false,
    });
  };
  const unsubscribe = client.subscribeErrors(({ error, generation, access }) => {
    if (disposed || generation !== client.getGeneration()) return;
    if (
      error.error === "MAINTENANCE" ||
      (access === "session" && (error.status === 401 || error.status === 429))
    )
      failed(error);
  });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load() {
      if (
        disposed ||
        snapshot.status === "maintenance" ||
        (snapshot.retryAt !== null && now() < snapshot.retryAt)
      )
        return Promise.resolve();
      if (loading) return loading;
      if (loggingOut) return loggingOut;
      const started = revision;
      publish({ ...snapshot, status: "loading", error: null, retryAt: null });
      const work = (async () => {
        try {
          const session = await api.current();
          if (disposed || started !== revision) return;
          if (!session) {
            invalidate();
            return;
          }
          const identity = `${session.portalSessionId}:${session.entityId}:${session.storeId}`;
          const previous = snapshot.session;
          const changed =
            !previous ||
            identity !== `${previous.portalSessionId}:${previous.entityId}:${previous.storeId}`;
          const generation = changed ? clearScope() : snapshot.generation;
          publish({
            status: "authenticated",
            session,
            scope: `${identity}:${generation}`,
            generation,
            error: null,
            retryAt: null,
            logoutPending: false,
          });
        } catch (error) {
          if (!disposed && started === revision) failed(safePortalError(error));
        }
      })();
      loading = work;
      void work.finally(() => {
        if (loading === work) loading = null;
      });
      return work;
    },
    logout() {
      if (
        disposed ||
        snapshot.status === "maintenance" ||
        (snapshot.retryAt !== null && now() < snapshot.retryAt)
      )
        return Promise.resolve();
      if (loggingOut) return loggingOut;
      // Cancel old reads before the write, but retain the actual session until success/401.
      const generation = clearScope();
      const started = revision;
      publish({ ...snapshot, generation, logoutPending: true, error: null, retryAt: null });
      const work = (async () => {
        try {
          await api.logout();
          if (!disposed && started === revision)
            invalidate(new PortalApiError("AUTH_REQUIRED", 401));
        } catch (error) {
          if (!disposed && started === revision) failed(safePortalError(error));
        }
      })();
      loggingOut = work;
      void work.finally(() => {
        if (loggingOut === work) loggingOut = null;
      });
      return work;
    },
    invalidate,
    captureScope() {
      if (
        disposed ||
        snapshot.status !== "authenticated" ||
        !snapshot.scope ||
        snapshot.logoutPending
      )
        return null;
      const key = snapshot.scope,
        generation = snapshot.generation,
        signal = scopeController.signal;
      return {
        key,
        generation,
        signal,
        isCurrent: () =>
          !disposed &&
          !signal.aborted &&
          snapshot.status === "authenticated" &&
          snapshot.scope === key &&
          snapshot.generation === generation &&
          !snapshot.logoutPending,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScope();
      unsubscribe();
      listeners.clear();
    },
  };
}
