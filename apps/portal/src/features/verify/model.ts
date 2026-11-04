import type { PortalClient } from "../../lib/api";
import { safePortalError, type PortalApiError } from "../../lib/api-errors";
import { createVerificationApi, type LicenseVerification } from "./api";

export interface VerificationSnapshot {
  readonly status: "input" | "loading" | "ready" | "error";
  readonly value: LicenseVerification | null;
  readonly error: PortalApiError | null;
  readonly retryAt: number | null;
}
export const initialVerification: VerificationSnapshot = Object.freeze({
  status: "input",
  value: null,
  error: null,
  retryAt: null,
});

export function createVerificationModel(
  client: PortalClient,
  options: { now?: () => number } = {},
) {
  const api = createVerificationApi(client),
    now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot = initialVerification,
    revision = 0,
    disposed = false;
  let request = new AbortController();
  let query: { code: string; rawRev: string | null } | null = null;
  const publish = (patch: Partial<VerificationSnapshot>) => {
    if (disposed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    listeners.forEach((listener) => listener());
  };
  const read = async () => {
    if (disposed || !query || (snapshot.retryAt !== null && now() < snapshot.retryAt)) return;
    const run = ++revision;
    request.abort();
    request = new AbortController();
    publish({ status: "loading", value: null, error: null, retryAt: null });
    try {
      const value = await api.get(query.code, query.rawRev, request.signal);
      if (!disposed && run === revision) publish({ status: "ready", value });
    } catch (value) {
      if (disposed || run !== revision) return;
      const error = safePortalError(value);
      publish({
        status: "error",
        value: null,
        error,
        retryAt: error.retryAfter === null ? null : now() + error.retryAfter * 1000,
      });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lookup(code: string, rawRev: string | null = null) {
      if (disposed || (snapshot.retryAt !== null && now() < snapshot.retryAt))
        return Promise.resolve();
      query = code ? { code, rawRev } : null;
      if (!query) {
        revision++;
        request.abort();
        publish({ ...initialVerification });
        return Promise.resolve();
      }
      return read();
    },
    refresh: read,
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      request.abort();
      query = null;
      snapshot = initialVerification;
      listeners.clear();
    },
  };
}
export type VerificationModel = ReturnType<typeof createVerificationModel>;
