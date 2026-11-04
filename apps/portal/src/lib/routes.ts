import type { ReactNode } from "react";

const ownership = {
  "/": { owner: "W6-10", access: "public" },
  "/a": { owner: "W6-10", access: "public" },
  "/v": { owner: "W6-12", access: "public" },
  "/items": { owner: "W6-11", access: "session" },
  "/items/$id": { owner: "W6-11", access: "session" },
  "/preview/$kind/$id": { owner: "W6-12", access: "session" },
} as const;
export type PortalRoute = {
  [P in keyof typeof ownership]: {
    readonly path: P;
    readonly owner: (typeof ownership)[P]["owner"];
    readonly access: (typeof ownership)[P]["access"];
    readonly render: (params: Readonly<Record<string, string>>) => ReactNode;
  };
}[keyof typeof ownership];
export interface PortalRouteMatch {
  readonly route: PortalRoute;
  readonly params: Readonly<Record<string, string>>;
}

/** Accept only a local navigation target; never resolve URL-supplied hosts or identities. */
export function safePortalTarget(target: string): string | null {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    Array.from(target).some((character) => character.charCodeAt(0) <= 32)
  )
    return null;
  const pathname = target.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("//") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  return target;
}

/** An ownership declaration is not an implemented page: only supplied leaves are matched. */
export function createPortalRoutes(routes: readonly PortalRoute[] = []) {
  const seen = new Set<string>();
  for (const route of routes) {
    const expected = ownership[route.path];
    if (
      !expected ||
      expected.owner !== route.owner ||
      expected.access !== route.access ||
      seen.has(route.path)
    ) {
      throw new Error("页面归属或访问边界不符合登记");
    }
    seen.add(route.path);
  }
  const registered = [...routes];
  return {
    match(target: string): PortalRouteMatch | null {
      if (!safePortalTarget(target)) return null;
      const pathname = target.split(/[?#]/, 1)[0] ?? "";
      const segments = pathname.split("/");
      for (const route of registered) {
        const expected = route.path.split("/");
        if (expected.length !== segments.length) continue;
        const params: Record<string, string> = {};
        const matches = expected.every((segment, index) => {
          const actual = segments[index] ?? "";
          if (!segment.startsWith("$")) return actual === segment;
          if (!actual || !/^[A-Za-z0-9_-]+$/.test(actual)) return false;
          params[segment.slice(1)] = actual;
          return true;
        });
        if (matches) return { route, params: Object.freeze(params) };
      }
      return null;
    },
  };
}
