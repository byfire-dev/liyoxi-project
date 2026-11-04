import type { paths } from "@liyoxi/contract/types/portal";

import { object, PortalApiError, readPortalError } from "./api-errors";

type Method = "get" | "post" | "delete";
export type PortalPath = keyof paths;
type Operation<P extends PortalPath, M extends Method> = NonNullable<paths[P][M]>;
type Methods<P extends PortalPath> = {
  [M in Method]: [Operation<P, M>] extends [never] ? never : M;
}[Method];
type Parameter<O, K extends "path" | "query"> = O extends { parameters: infer P }
  ? K extends keyof P
    ? NonNullable<P[K]>
    : never
  : never;
type Body<O> = O extends { requestBody: { content: infer C } }
  ? C extends { "application/json": infer B }
    ? B
    : C extends { "application/x-sentry-envelope": infer B }
      ? B
      : never
  : never;
type Field<K extends string, V> = [V] extends [never] ? { [P in K]?: never } : { [P in K]: V };
type Data<R> = R extends { content: { "application/json": { data: infer D } } } ? D : never;
type Result<O> = O extends { responses: infer R } ? Data<R[Extract<keyof R, 200 | 202>]> : never;
export type PortalRequestOptions<P extends PortalPath, M extends Method> = Field<
  "path",
  Parameter<Operation<P, M>, "path">
> &
  Field<"query", Parameter<Operation<P, M>, "query">> &
  Field<"body", Body<Operation<P, M>>> & {
    signal?: AbortSignal;
    querySerializer?: (query: Parameter<Operation<P, M>, "query">) => URLSearchParams;
  } & (P extends "/api/v1/portal/portal-tickets/{portalTicketId}"
    ? M extends "get"
      ? { pollSecret: string }
      : { pollSecret?: never }
    : { pollSecret?: never });

export interface PortalFailure {
  readonly error: PortalApiError;
  readonly generation: number;
  readonly access: "public" | "session";
}
export interface PortalClient {
  request<P extends PortalPath, M extends Methods<P>>(
    path: P,
    method: M,
    options: PortalRequestOptions<P, M>,
  ): Promise<Result<Operation<P, M>>>;
  subscribeErrors(listener: (failure: PortalFailure) => void): () => void;
  getGeneration(): number;
  advanceScope(): number;
  dispose(): void;
}

const publicPaths = new Set<PortalPath>([
  "/api/v1/portal/portal-tickets",
  "/api/v1/portal/portal-tickets/{portalTicketId}",
  "/api/v1/portal/portal-tickets/{portalTicketId}/exchange",
  "/api/v1/portal/license-verifications",
  "/api/v1/portal/client-errors",
]);

/** Origin is deliberately not configurable: URL/query/state cannot redirect authentication. */
export function createPortalClient(
  options: { fetch?: typeof fetch; now?: () => number } = {},
): PortalClient {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const listeners = new Set<(failure: PortalFailure) => void>();
  const requests = new Map<AbortController, "public" | "session">();
  let generation = 0;
  let disposed = false;
  let maintenance: PortalApiError | null = null;
  let cooldown: { until: number; error: PortalApiError } | null = null;

  return {
    async request(path, method, options) {
      if (disposed) throw new PortalApiError("CLIENT_DISPOSED");
      const raw = path === "/api/v1/portal/client-errors";
      // Telemetry has its own bounded writer; its failures cannot govern business requests.
      if (!raw && maintenance) throw maintenance;
      if (!raw && cooldown && now() < cooldown.until) throw cooldown.error;
      if (!/^\/api\/v1\/portal\/[A-Za-z0-9_/{}-]+$/.test(path) || path.includes("//")) {
        throw new PortalApiError("INVALID_REQUEST");
      }
      const params = (options.path ?? {}) as Record<string, unknown>;
      const relative = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
        const value = params[key];
        if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
          throw new PortalApiError("INVALID_REQUEST");
        }
        return encodeURIComponent(value);
      });
      const query = options.querySerializer
        ? options.querySerializer(options.query as never)
        : new URLSearchParams(
            Object.entries(options.query ?? {}).flatMap(([key, value]) =>
              value === undefined || value === null ? [] : [[key, String(value)]],
            ),
          );
      for (const key of query.keys()) {
        if (
          !/^[A-Za-z][A-Za-z0-9]*$/.test(key) ||
          /secret|token|cookie|origin|authorization/i.test(key)
        ) {
          throw new PortalApiError("INVALID_REQUEST");
        }
      }
      const suffix = query.toString();
      // A relative URL plus redirect:error keeps both initial and redirected requests on this origin.
      const url = `${relative}${suffix ? `?${suffix}` : ""}`;
      const headers = new Headers({ Accept: "application/json" });
      if (method !== "get") headers.set("X-LYX-Portal", "1");
      if (options.pollSecret !== undefined) {
        if (
          path !== "/api/v1/portal/portal-tickets/{portalTicketId}" ||
          method !== "get" ||
          !/^[A-Za-z0-9_-]{43}$/.test(options.pollSecret)
        )
          throw new PortalApiError("INVALID_REQUEST");
        headers.set("X-Poll-Secret", options.pollSecret);
      }
      let body: string | undefined;
      if (options.body !== undefined) {
        if (raw && typeof options.body !== "string") throw new PortalApiError("INVALID_REQUEST");
        body = raw ? String(options.body) : JSON.stringify(options.body);
        headers.set("Content-Type", raw ? "application/x-sentry-envelope" : "application/json");
      }
      const access = publicPaths.has(path) ? "public" : "session";
      const started = generation;
      const controller = new AbortController();
      let published = false;
      const publish = (error: PortalApiError) => {
        if (raw || published) return;
        published = true;
        for (const listener of listeners) {
          try {
            listener({ error, generation: started, access });
          } catch {
            // An observer cannot change the request outcome or trigger recursive reporting.
          }
        }
      };
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      requests.set(controller, access);
      try {
        const response = await send(url, {
          method: method.toUpperCase(),
          headers,
          body,
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (
          disposed ||
          controller.signal.aborted ||
          (access === "session" && started !== generation)
        ) {
          throw new PortalApiError("REQUEST_ABORTED");
        }
        if (!response.ok) {
          const error = readPortalError(payload, response.status, response.headers, now());
          if (!raw && error.error === "MAINTENANCE") maintenance = error;
          if (!raw && error.status === 429 && error.retryAfter !== null) {
            cooldown = { until: now() + error.retryAfter * 1000, error };
          }
          publish(error);
          throw error;
        }
        const envelope = object(payload);
        if (
          response.status !== (raw ? 202 : 200) ||
          envelope?.code !== 0 ||
          !Object.hasOwn(envelope, "data") ||
          (raw && envelope.data !== null)
        )
          throw new PortalApiError("INVALID_RESPONSE", response.status);
        return envelope.data as never;
      } catch (error) {
        // fetch and JSON errors may contain URLs or bodies; never retain their original object.
        const safe =
          error instanceof PortalApiError
            ? error
            : new PortalApiError(
                disposed ||
                  controller.signal.aborted ||
                  (access === "session" && started !== generation)
                  ? "REQUEST_ABORTED"
                  : "NETWORK_ERROR",
              );
        if (safe.error === "NETWORK_ERROR" || safe.error === "INVALID_RESPONSE") publish(safe);
        throw safe;
      } finally {
        requests.delete(controller);
        options.signal?.removeEventListener("abort", abort);
      }
    },
    subscribeErrors(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getGeneration: () => generation,
    advanceScope() {
      generation += 1;
      for (const [controller, access] of requests) if (access === "session") controller.abort();
      return generation;
    },
    dispose() {
      disposed = true;
      generation += 1;
      for (const controller of requests.keys()) controller.abort();
      listeners.clear();
    },
  };
}
