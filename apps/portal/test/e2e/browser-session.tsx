/** Private edge entry only. Production index/App never import this module. */
import { isErrorSymbol } from "@liyoxi/contract/errors";
import { theme } from "antd";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import type { PortalTicketStatus } from "../../src/features/auth/api";
import { SessionBoundary } from "../../src/features/session/SessionBoundary";
import type { PortalSessionSnapshot } from "../../src/features/session/model";
import { PortalApiError } from "../../src/lib/api-errors";
import { createPortalRuntime } from "../../src/lib/runtime";
import { App } from "../../src/App";
import { createPreviewRoutes } from "../../src/features/preview/routes";
import { createVerificationRoutes } from "../../src/features/verify/routes";
import { createPortalClientReporting } from "../../src/lib/client-reporting";

export interface LiveSessionState {
  readonly status: PortalSessionSnapshot["status"];
  readonly authenticated: boolean;
  readonly portalSessionId: string | null;
  readonly entityId: string | null;
  readonly storeId: string | null;
  readonly error: string | null;
  readonly httpStatus: number | null;
  readonly reason: string | null;
  readonly revokeReason: string | null;
  readonly logoutPending: boolean;
  readonly generation: number;
}
export interface LivePrivacy {
  readonly observedTicketSecret: boolean;
  readonly auditComplete: boolean;
  readonly domSafe: boolean;
  readonly urlSafe: boolean;
  readonly storageEmpty: boolean;
  readonly storageSafe: boolean;
  readonly documentCookieHidden: boolean;
  readonly stateSafe: boolean;
  readonly safe: boolean;
}
export type LiveReply<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly httpStatus: number };
type TrafficKind =
  "ticket" | "session" | "ad-detail" | "ad-playback" | "verification" | "report" | "other";
export interface LiveTraffic {
  readonly pending: number;
  readonly items: readonly {
    kind: TrafficKind;
    method: string;
    status: number;
    revision: string | null;
  }[];
}
export interface PortalLiveBridge {
  readonly version: 1;
  beginTicket(): Promise<
    LiveReply<{ portalTicketId: string; shortCode: string; pairDigits: string }>
  >;
  pollTicket(): Promise<LiveReply<{ status: PortalTicketStatus["status"] }>>;
  finishExchange(): Promise<
    LiveReply<{ outcome: "consumed" | "rejected"; state: LiveSessionState }>
  >;
  loadSession(): Promise<LiveReply<LiveSessionState>>;
  logout(): Promise<LiveReply<LiveSessionState>>;
  snapshot(): LiveSessionState;
  privacy(): LivePrivacy;
  publicPrivacy(): LivePrivacy & { readonly publicOnly: boolean };
  traffic(): LiveTraffic;
  navigate(target: string): { readonly navigated: true };
  reportProbe(): { readonly requested: true };
  dispose(): { readonly disposed: true };
}
declare global {
  interface Window {
    readonly __LYX_PORTAL_LIVE__: PortalLiveBridge;
  }
}

const localErrors = new Set([
  "NETWORK_ERROR",
  "HTTP_ERROR",
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "CLIENT_DISPOSED",
  "REQUEST_ABORTED",
]);
const safeError = (value: unknown): string =>
  typeof value === "string" && (isErrorSymbol(value) || localErrors.has(value))
    ? value
    : "BROWSER_ACTION_FAILED";
const invalidReasons = new Set(["not_found", "expired", "revoked", "authorizer_invalid"]);
const revokeReasons = new Set([
  "owner_revoked",
  "membership_changed",
  "account_action",
  "portal_logout",
  "expired",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeId = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : null);

// Audit only: delegate the real fetch unchanged. Secrets from the real create response stay
// in this module's closure and are used only for boolean leakage checks, never in bridge DTOs.
const secrets = new Set<string>();
let auditComplete = true;
let pendingFetches = 0,
  authTraffic = 0;
const traffic: { kind: TrafficKind; method: string; status: number; revision: string | null }[] =
  [];
const actualFetch = globalThis.fetch.bind(globalThis);
const auditedFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    location.origin,
  );
  const kind: TrafficKind = url.pathname.includes("/portal-tickets")
    ? "ticket"
    : url.pathname.includes("/session")
      ? "session"
      : url.pathname === "/api/v1/portal/license-verifications"
        ? "verification"
        : url.pathname === "/api/v1/portal/client-errors"
          ? "report"
          : /\/ads\/[^/]+\/playback-urls$/.test(url.pathname)
            ? "ad-playback"
            : /\/ads\/[^/]+$/.test(url.pathname)
              ? "ad-detail"
              : "other";
  if (kind === "ticket" || kind === "session") authTraffic++;
  pendingFetches++;
  let response: Response;
  try {
    response = await actualFetch(input, init);
  } finally {
    pendingFetches--;
  }
  if (traffic.length < 256)
    traffic.push({
      kind,
      method: init?.method ?? "GET",
      status: response.status,
      revision:
        kind === "verification" ? (url.searchParams.get("revNo")?.slice(0, 32) ?? null) : null,
    });
  else auditComplete = false;
  if (input === "/api/v1/portal/portal-tickets" && init?.method === "POST" && response.ok) {
    try {
      const value: unknown = await response.clone().json();
      const data =
        value !== null && typeof value === "object" && "data" in value ? value.data : null;
      const secret =
        data !== null && typeof data === "object" && "pollSecret" in data ? data.pollSecret : null;
      if (typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret) && secrets.size < 10)
        secrets.add(secret);
      else auditComplete = false;
    } catch {
      auditComplete = false;
    }
  }
  return response;
};
const runtime = createPortalRuntime({ fetch: auditedFetch });
// Fake public DSN enables the production same-origin sender. No external Sentry request is made.
let reporting: ReturnType<typeof createPortalClientReporting> | undefined;
let disposed = false;
let boundaryMounted = false;
const viewListeners = new Set<() => void>();
const notifyView = () => {
  for (const listener of viewListeners) listener();
};

function snapshot(): LiveSessionState {
  const state = runtime.session.getSnapshot();
  const reason = state.error?.details.reason,
    revokeReason = state.error?.details.revokeReason;
  return Object.freeze({
    status: state.status,
    authenticated: !disposed && state.status === "authenticated" && state.session !== null,
    portalSessionId: safeId(state.session?.portalSessionId),
    entityId: safeId(state.session?.entityId),
    storeId: safeId(state.session?.storeId),
    error: state.error ? safeError(state.error.error) : null,
    httpStatus: state.error?.status ?? null,
    reason: typeof reason === "string" && invalidReasons.has(reason) ? reason : null,
    revokeReason:
      typeof revokeReason === "string" && revokeReasons.has(revokeReason) ? revokeReason : null,
    logoutPending: state.logoutPending,
    generation: state.generation,
  });
}

function privacy(publicOnly = false): LivePrivacy {
  const withoutSecret = (text: string) => [...secrets].every((secret) => !text.includes(secret));
  let storageEmpty = false,
    storageSafe = false;
  try {
    const values: string[] = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key !== null) values.push(key, storage.getItem(key) ?? "");
      }
    }
    storageEmpty = localStorage.length === 0 && sessionStorage.length === 0;
    storageSafe = values.every(withoutSecret);
  } catch {
    /* A failed inspection is not evidence of safety. */
  }
  const domSafe = withoutSecret(document.documentElement.outerHTML);
  const urlSafe = withoutSecret(window.location.href);
  const documentCookieHidden =
    !document.cookie.includes("__Host-lyx_portal") && withoutSecret(document.cookie);
  const stateSafe = withoutSecret(JSON.stringify(snapshot()));
  return Object.freeze({
    observedTicketSecret: secrets.size > 0,
    auditComplete,
    domSafe,
    urlSafe,
    storageEmpty,
    storageSafe,
    documentCookieHidden,
    stateSafe,
    safe:
      (publicOnly
        ? secrets.size === 0 && authTraffic === 0 && snapshot().status === "unknown"
        : secrets.size > 0) &&
      auditComplete &&
      domSafe &&
      urlSafe &&
      storageEmpty &&
      storageSafe &&
      documentCookieHidden &&
      stateSafe,
  });
}

async function action<T>(run: () => Promise<T>): Promise<LiveReply<T>> {
  if (disposed) return { ok: false, error: "CLIENT_DISPOSED", httpStatus: 0 };
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof PortalApiError ? safeError(error.error) : "BROWSER_ACTION_FAILED",
      httpStatus: error instanceof PortalApiError ? error.status : 0,
    };
  }
}

function showBoundary() {
  boundaryMounted = true;
  notifyView();
}
const subscribeView = (listener: () => void) => {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
};
function BrowserSession() {
  const { token } = theme.useToken();
  const mounted = useSyncExternalStore(subscribeView, () => boundaryMounted);
  const state = useSyncExternalStore(runtime.session.subscribe, runtime.session.getSnapshot);
  return (
    <main
      data-testid="portal-live-ready"
      style={{
        minHeight: "100vh",
        padding: token.paddingLG,
        background: token.colorBgLayout,
        color: token.colorText,
        fontFamily: token.fontFamily,
      }}
    >
      <h1>电脑授权会话验证</h1>
      <p data-testid="portal-live-state" data-status={state.status}>
        {state.status === "authenticated"
          ? "已读取真实电脑授权"
          : state.status === "invalid"
            ? "电脑授权已失效"
            : "等待核对电脑授权"}
      </p>
      {mounted ? (
        <div data-testid="portal-live-boundary">
          <SessionBoundary store={runtime.session}>
            <p data-testid="portal-live-private">当前授权允许查看此内容。</p>
          </SessionBoundary>
        </div>
      ) : (
        <p>尚未读取会话。</p>
      )}
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("PORTAL_LIVE_ROOT_MISSING");
const root = createRoot(container);
// The private technical document uses the existing '/' ownership slot only in this build.
if (location.pathname === "/__portal-live/session") history.replaceState(null, "", "/");
const routes = [
  {
    path: "/" as const,
    owner: "W6-10" as const,
    access: "public" as const,
    render: () => <BrowserSession />,
  },
  ...createPreviewRoutes(runtime),
  ...createVerificationRoutes(runtime),
];
root.render(
  <StrictMode>
    <App runtime={runtime} routes={routes} />
  </StrictMode>,
);

const bridge: PortalLiveBridge = Object.freeze({
  version: 1,
  beginTicket: () =>
    action(async () => {
      const ticket = await runtime.tickets.create();
      return {
        portalTicketId: ticket.portalTicketId,
        shortCode: ticket.shortCode,
        pairDigits: ticket.pairDigits,
      };
    }),
  pollTicket: () => action(async () => ({ status: (await runtime.tickets.poll()).status })),
  finishExchange: () =>
    action(async () => {
      const result = await runtime.tickets.exchange();
      // Never inject the exchange DTO into the session model: current is authoritative.
      await runtime.session.load();
      showBoundary();
      return { outcome: result.status, state: snapshot() };
    }),
  loadSession: () =>
    action(async () => {
      await runtime.session.load();
      showBoundary();
      return snapshot();
    }),
  logout: () =>
    action(async () => {
      await runtime.session.logout();
      return snapshot();
    }),
  snapshot,
  privacy: () => privacy(),
  publicPrivacy: () =>
    Object.freeze({ ...privacy(true), publicOnly: secrets.size === 0 && authTraffic === 0 }),
  traffic: () => ({ pending: pendingFetches, items: traffic.map((item) => ({ ...item })) }),
  navigate(target: string) {
    const url = new URL(target, location.origin);
    if (
      url.origin !== location.origin ||
      !target.startsWith("/") ||
      target.startsWith("//") ||
      url.hash ||
      !(url.pathname === "/v" || /^\/preview\/(ad|sample)\/[0-9a-f-]{36}$/i.test(url.pathname))
    )
      throw new Error("BROWSER_TARGET_INVALID");
    history.pushState(null, "", target);
    dispatchEvent(new PopStateEvent("popstate"));
    return { navigated: true as const };
  },
  reportProbe() {
    reporting ??= createPortalClientReporting({
      client: runtime.client,
      dsn: "https://public-live-probe@sentry.invalid/1",
      build: "portal-live-preview",
    });
    reporting.capture(new Error("PUBLIC-PORTAL-ERROR-SENTINEL"));
    return { requested: true as const };
  },
  dispose() {
    if (!disposed) {
      disposed = true;
      root.unmount();
      reporting?.dispose();
      runtime.dispose();
      viewListeners.clear();
      secrets.clear();
      window.removeEventListener("pagehide", close);
    }
    return { disposed: true as const };
  },
});
function close() {
  bridge.dispose();
}
window.addEventListener("pagehide", close);
Object.defineProperty(window, "__LYX_PORTAL_LIVE__", {
  value: bridge,
  writable: false,
  configurable: false,
});
