import type { PortalRuntime } from "../../lib/runtime";
import { PortalApiError, safePortalError } from "../../lib/api-errors";
import { createAdPreviewApi, validPreviewId, type AdDetail, type AdPlayback } from "./api";

export interface AdPreviewSnapshot {
  readonly status: "idle" | "loading" | "ready" | "error" | "invalid";
  readonly detail: AdDetail | null;
  readonly playback: AdPlayback | null;
  readonly media: "idle" | "signing" | "ready" | "expired" | "failed";
  readonly notice: "version_changed" | null;
  readonly error: PortalApiError | null;
  readonly retryAt: number | null;
}
export const initialAdPreview: AdPreviewSnapshot = Object.freeze({
  status: "idle",
  detail: null,
  playback: null,
  media: "idle",
  notice: null,
  error: null,
  retryAt: null,
});

/** Owns this leaf's requests and media lifetime; authentication remains in the shared session. */
export function createAdPreviewModel(
  runtime: Pick<PortalRuntime, "client" | "session">,
  adId: string,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const api = createAdPreviewApi(runtime.client);
  const scope = runtime.session.captureScope();
  const listeners = new Set<() => void>();
  let snapshot = initialAdPreview,
    revision = 0,
    disposed = false;
  let request = new AbortController();
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const current = (run: number) => !disposed && revision === run && Boolean(scope?.isCurrent());
  const publish = (patch: Partial<AdPreviewSnapshot>) => {
    if (disposed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    listeners.forEach((listener) => listener());
  };
  const cancel = () => {
    revision++;
    request.abort();
    request = new AbortController();
    clearTimeout(expiry);
    return revision;
  };
  const unsubscribe = runtime.session.subscribe(() => {
    if (!scope?.isCurrent()) {
      cancel();
      publish({ ...initialAdPreview, status: "invalid" });
    }
  });
  const cooling = () => snapshot.retryAt !== null && now() < snapshot.retryAt;
  const errorState = (value: unknown) => {
    const error = safePortalError(value);
    return { error, retryAt: error.retryAfter === null ? null : now() + error.retryAfter * 1000 };
  };
  const load = async (notice: AdPreviewSnapshot["notice"] = null) => {
    if (disposed || cooling()) return;
    const run = cancel();
    if (!validPreviewId(adId) || !scope?.isCurrent()) {
      publish({ ...initialAdPreview, status: "invalid" });
      return;
    }
    publish({ ...initialAdPreview, status: "loading", notice });
    try {
      const detail = await api.detail(adId, AbortSignal.any([scope.signal, request.signal]));
      if (!current(run)) return;
      if (detail.adId !== adId || detail.currentVersionNo !== detail.currentVersion.versionNo)
        throw new PortalApiError("INVALID_RESPONSE");
      publish({ status: "ready", detail });
    } catch (error) {
      if (current(run)) publish({ status: "error", ...errorState(error) });
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
    load: () => load(),
    async play() {
      const detail = snapshot.detail;
      if (
        disposed ||
        cooling() ||
        snapshot.status !== "ready" ||
        snapshot.media === "signing" ||
        !detail?.isPortalPreviewable ||
        !scope?.isCurrent()
      )
        return;
      const run = cancel(),
        versionNo = detail.currentVersionNo;
      publish({ playback: null, media: "signing", notice: null, error: null, retryAt: null });
      try {
        const playback = await api.playback(
          adId,
          versionNo,
          AbortSignal.any([scope.signal, request.signal]),
        );
        if (!current(run) || snapshot.detail?.currentVersionNo !== versionNo) return;
        const remaining = Date.parse(playback.expiresAt!) - now();
        if (remaining <= 0) {
          publish({ media: "expired", playback: null });
          return;
        }
        publish({ media: "ready", playback });
        expiry = setTimeout(
          () => {
            if (current(run)) publish({ media: "expired", playback: null });
          },
          Math.min(remaining, 2_147_483_647),
        );
      } catch (value) {
        if (!current(run)) return;
        const error = safePortalError(value);
        if (error.error === "AD_VERSION_STALE") {
          // Only metadata is refreshed. A new version always requires a new explicit click.
          await load("version_changed");
        } else publish({ media: "failed", playback: null, ...errorState(error) });
      }
    },
    mediaFailed() {
      if (!scope?.isCurrent() || !snapshot.playback) return;
      cancel();
      publish({ media: "failed", playback: null, error: null });
    },
    dispose() {
      if (disposed) return;
      cancel();
      unsubscribe();
      snapshot = initialAdPreview;
      disposed = true;
      listeners.clear();
    },
  };
}
export type AdPreviewModel = ReturnType<typeof createAdPreviewModel>;
