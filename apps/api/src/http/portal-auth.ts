import {
  AppError,
  createIdentityContext,
  PORTAL_CAPABILITIES,
  PORTAL_SESSION_TTL_SECONDS,
} from "@liyoxi/services";
import type { PortalPrincipal, RequestMeta } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { merchantServicesOf } from "../merchant/services.js";
import type { RouteMiddlewareFactory } from "../routing/types.js";

export const PORTAL_COOKIE = "__Host-lyx_portal";
export const portalCookie = (token: string, clear = false): string =>
  `${PORTAL_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : PORTAL_SESSION_TTL_SECONDS}`;
function cookieOf(header: string | undefined): string | null {
  const values = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PORTAL_COOKIE}=`));
  if (!values.length) return null;
  // Duplicate cookie ambiguity never chooses a more privileged credential.
  return values.length === 1 ? values[0]!.slice(PORTAL_COOKIE.length + 1) : "";
}
export const portalAuth: RouteMiddlewareFactory = (route, runtime) => {
  const optional = route["x-auth"] === "optional";
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (route["x-auth"] === "public") return next();
    const token = cookieOf(c.req.header("cookie"));
    if (token === null) {
      if (optional) return next();
      throw new AppError("AUTH_REQUIRED");
    }
    let principal: PortalPrincipal;
    try {
      principal = await merchantServicesOf(runtime).portalSessions.authenticate(token);
    } catch (error) {
      if (optional && error instanceof AppError && error.error === "PORTAL_SESSION_INVALID")
        return next();
      throw error;
    }
    c.set("portalSession", principal);
    c.set("sessionId", principal.sessionId);
    c.set(
      "identity",
      createIdentityContext({
        actor: { type: "merchant", client: "portal", role: "owner", id: principal.merchantUserId },
        entityId: principal.entityId,
        storeId: principal.storeId,
        requestId: c.var.requestId,
        ip: c.var.clientIp,
        userAgent: c.req.header("user-agent") ?? null,
      }),
    );
    return next();
  };
};
export const portalCsrf: RouteMiddlewareFactory = (route, runtime) => {
  if (route.method === "get") return null;
  return async (c, next) => {
    if (
      !runtime.env.PORTAL_PUBLIC_ORIGIN ||
      c.req.header("origin") !== runtime.env.PORTAL_PUBLIC_ORIGIN ||
      c.req.header("x-lyx-portal") !== "1"
    )
      throw new AppError("ORIGIN_REJECTED");
    await next();
  };
};
// This operation allowlist permits only the frozen read/export surface. Historical
// sample.view is a capability fact, not permission to bring Q9 sample routes back.
const READ_OPERATIONS = new Set([
  "portal.session.current.get",
  "portal.session.current.delete",
  "portal.orderItem.list",
  "portal.orderItem.publishList.get",
  "portal.orderItem.downloadUrls",
  "portal.orderItem.release.get",
  "portal.ad.list",
  "portal.ad.get",
  "portal.ad.playbackUrls",
]);
const PUBLIC_OPERATIONS = new Set([
  "portal.portalTicket.create",
  "portal.portalTicket.get",
  "portal.portalTicket.exchange",
  "portal.licenseVerification.get",
  "portal.clientError.create",
]);
export function portalOperationAllowed(
  operationId: string,
  capability: string | null | undefined,
  isPublic: boolean,
): boolean {
  return (
    (isPublic ? PUBLIC_OPERATIONS : READ_OPERATIONS).has(operationId) &&
    (capability == null || (PORTAL_CAPABILITIES as readonly string[]).includes(capability))
  );
}
export const portalCapability: RouteMiddlewareFactory = (route) => async (_c, next) => {
  if (
    !portalOperationAllowed(
      route.operationId,
      route["x-capability"],
      route["x-auth"] === "public" || route["x-auth"] === "optional",
    )
  )
    throw new AppError("ROLE_FORBIDDEN");
  await next();
};
export function portalPrincipalOf(c: Context<ApiEnv>): PortalPrincipal {
  const principal = c.get("portalSession");
  if (!principal) throw new AppError("AUTH_REQUIRED");
  return principal;
}
export function portalRequestMeta(c: Context<ApiEnv>): RequestMeta {
  return {
    requestId: c.var.requestId,
    ip: c.var.clientIp,
    userAgent: c.req.header("user-agent") ?? null,
    clientVersion: null,
  };
}
