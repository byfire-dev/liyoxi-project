import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PortalSessionItem, PortalSessionView } from "@liyoxi/contract";
import type { PortalSession } from "@liyoxi/db";
import { record as recordAudit, recordAuthEvent } from "../audit/index.js";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { Clock, IdempotencyContext, Tx, TxRunner } from "../kernel/index.js";
import { assertPortalOwner } from "./portal-owner.js";
import type { PortalOwnerRequest } from "./portal-owner.js";
import type { RequestMeta } from "./types.js";

export const PORTAL_CAPABILITIES = ["delivery.download", "sample.view", "ad.view"] as const;
export const PORTAL_SESSION_TTL_SECONDS = 7200;
export const portalSecretHash = (secret: string): Buffer<ArrayBuffer> =>
  Buffer.from(createHash("sha256").update(secret).digest());
export const newPortalSecret = (): string => randomBytes(32).toString("base64url");
export function portalSecretMatches(secret: string, hash: Uint8Array): boolean {
  const actual = portalSecretHash(secret);
  return hash.length === actual.length && timingSafeEqual(actual, hash);
}
export function portalBrowser(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  if (!browser) return "未知浏览器";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} · ${os}` : browser;
}

export interface PortalPrincipal {
  readonly sessionId: string;
  readonly merchantUserId: string;
  readonly entityId: string;
  readonly storeId: string;
  readonly view: PortalSessionView;
}
export interface PortalSessionDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly appid: string;
}
const sessionInclude = { store: true, entity: true, approvedByUser: true } as const;
type ViewRow = PortalSession & {
  store: { name: string | null; lifecycle: string; entityId: string };
  entity: { name: string | null };
  approvedByUser: { phoneMask: string | null; status: string };
};
export function portalSessionView(row: ViewRow, now: Date): PortalSessionView {
  return {
    portalSessionId: row.id,
    storeId: row.storeId,
    storeName: row.store.name,
    isStoreArchived: row.store.lifecycle === "archived",
    entityId: row.entityId,
    entityName: row.entity.name,
    authorizerPhoneMask: row.approvedByUser.phoneMask,
    grantScope: "store",
    capabilities: [...PORTAL_CAPABILITIES],
    authorizedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    serverTime: now.toISOString(),
  };
}
function sessionItem(row: PortalSession & { store: { name: string | null } }): PortalSessionItem {
  return {
    portalSessionId: row.id,
    storeId: row.storeId,
    storeName: row.store.name,
    grantScope: "store",
    browser: portalBrowser(row.userAgent),
    regionHint: null,
    authorizedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
function invalid(
  reason: "not_found" | "expired" | "revoked" | "authorizer_invalid",
  revokeReason: string | null = null,
): never {
  throw new AppError("PORTAL_SESSION_INVALID", { details: { reason, revokeReason } });
}

/** portal owns ticket consumption; session insert + login event share that exact transaction. */
export async function createPortalSession(
  tx: Tx,
  now: Date,
  grant: {
    portalTicketId: string;
    approvedByUserId: string;
    entityId: string;
    storeId: string;
  },
  meta: RequestMeta,
): Promise<{ token: string; view: PortalSessionView }> {
  const token = newPortalSecret();
  const row = await tx.portalSession.create({
    data: {
      id: uuidv7(),
      ...grant,
      tokenHash: portalSecretHash(token),
      grantScope: "store",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + PORTAL_SESSION_TTL_SECONDS * 1000),
      ip: meta.ip ?? "",
      userAgent: (meta.userAgent ?? "").slice(0, 512),
    },
    include: sessionInclude,
  });
  await recordAuthEvent(tx, {
    space: "portal",
    method: "ticket",
    subjectId: grant.approvedByUserId,
    event: "login_success",
    ip: meta.ip,
    userAgent: meta.userAgent,
    at: now,
    detail: { sessionId: row.id, requestId: meta.requestId },
  });
  return { token, view: portalSessionView(row, now) };
}

/** Read-only per-request authority. One SQL snapshot includes membership; no renewal or repair. */
export async function authenticatePortalSession(
  tx: Tx,
  token: string,
  now: Date,
): Promise<PortalPrincipal> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) invalid("not_found");
  const [row] = await tx.$queryRaw<
    (PortalSession & {
      storeName: string | null;
      storeLifecycle: string;
      entityName: string | null;
      phoneMask: string | null;
      accountStatus: string;
      isOwner: boolean;
    })[]
  >`
    SELECT s.id, s.approved_by_user_id AS "approvedByUserId", s.entity_id AS "entityId",
      s.store_id AS "storeId", s.grant_scope AS "grantScope", s.created_at AS "createdAt",
      s.expires_at AS "expiresAt", s.revoked_at AS "revokedAt", s.revoke_reason AS "revokeReason",
      t.name AS "storeName", t.lifecycle AS "storeLifecycle", e.name AS "entityName",
      u.phone_mask AS "phoneMask", u.status AS "accountStatus",
      EXISTS (SELECT 1 FROM entity_member m WHERE m.entity_id=s.entity_id
        AND m.merchant_user_id=s.approved_by_user_id AND m.role='owner' AND m.status='active') AS "isOwner"
    FROM portal_session s JOIN merchant_user u ON u.id=s.approved_by_user_id
    JOIN store t ON t.id=s.store_id AND t.entity_id=s.entity_id JOIN entity e ON e.id=s.entity_id
    WHERE s.token_hash=${portalSecretHash(token)}
  `;
  if (!row) invalid("not_found");
  if (row.revokedAt) invalid("revoked", row.revokeReason);
  if (row.expiresAt.getTime() <= now.getTime()) invalid("expired");
  if (row.accountStatus !== "active" || !row.isOwner || row.grantScope !== "store")
    invalid("authorizer_invalid");
  const view = portalSessionView(
    {
      ...row,
      store: { name: row.storeName, lifecycle: row.storeLifecycle, entityId: row.entityId },
      entity: { name: row.entityName },
      approvedByUser: { phoneMask: row.phoneMask, status: row.accountStatus },
    },
    now,
  );
  return {
    sessionId: row.id,
    merchantUserId: row.approvedByUserId,
    entityId: row.entityId,
    storeId: row.storeId,
    view,
  };
}

export function createPortalSessions(deps: PortalSessionDeps) {
  return {
    authenticate: (token: string) =>
      deps.tx.run((tx) => authenticatePortalSession(tx, token, deps.clock.now())),
    async list(request: PortalOwnerRequest): Promise<{ items: PortalSessionItem[] }> {
      return deps.tx.run(async (tx) => {
        const owner = await assertPortalOwner(tx, request, deps.clock, deps.appid);
        const rows = await tx.portalSession.findMany({
          where: {
            approvedByUserId: owner.merchantUserId,
            entityId: owner.entityId,
            revokedAt: null,
            expiresAt: { gt: deps.clock.now() },
          },
          include: { store: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        return { items: rows.map(sessionItem) };
      });
    },
    async revoke(
      request: PortalOwnerRequest,
      id: string,
      options: { idem?: IdempotencyContext } = {},
    ): Promise<PortalSessionItem> {
      return deps.tx.run(async (tx) => {
        const owner = await assertPortalOwner(tx, request, deps.clock, deps.appid, true);
        const where = { id, approvedByUserId: owner.merchantUserId, entityId: owner.entityId };
        await tx.$queryRaw`SELECT id FROM portal_session WHERE id=${id}::uuid
          AND approved_by_user_id=${owner.merchantUserId}::uuid
          AND entity_id=${owner.entityId}::uuid FOR UPDATE`;
        await assertPortalOwner(tx, request, deps.clock, deps.appid);
        const found = await tx.portalSession.findFirst({ where, include: { store: true } });
        if (!found) throw new AppError("NOT_FOUND");
        const now = deps.clock.now();
        const changed = await tx.portalSession.updateMany({
          where: { ...where, revokedAt: null, expiresAt: { gt: now } },
          data: { revokedAt: now, updatedAt: now, revokeReason: "owner_revoked" },
        });
        if (changed.count)
          await recordAudit(
            tx,
            request.ctx.actor,
            { ...request.ctx, authMethod: "weapp", sessionId: request.principal.sessionId },
            {
              stream: "activity",
              category: "account_security",
              action: "identity.portal_session.revoke",
              summary: "撤销电脑授权",
              target: { type: "portal_session", id },
              entityId: owner.entityId,
              storeId: found.storeId,
            },
          );
        return sessionItem(
          await tx.portalSession.findUniqueOrThrow({ where: { id }, include: { store: true } }),
        );
      }, options);
    },
    async logout(principal: PortalPrincipal, meta: RequestMeta): Promise<void> {
      await deps.tx.run(async (tx) => {
        const where = {
          id: principal.sessionId,
          approvedByUserId: principal.merchantUserId,
          entityId: principal.entityId,
          storeId: principal.storeId,
        };
        await tx.$queryRaw`SELECT id FROM portal_session WHERE id=${principal.sessionId}::uuid
          AND approved_by_user_id=${principal.merchantUserId}::uuid
          AND entity_id=${principal.entityId}::uuid AND store_id=${principal.storeId}::uuid FOR UPDATE`;
        const row = await tx.portalSession.findFirst({ where });
        const now = deps.clock.now();
        if (!row) invalid("not_found");
        if (row.revokedAt) invalid("revoked", row.revokeReason);
        if (row.expiresAt.getTime() <= now.getTime()) invalid("expired");
        const changed = await tx.portalSession.updateMany({
          where: {
            ...where,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { revokedAt: now, updatedAt: now, revokeReason: "portal_logout" },
        });
        if (!changed.count) invalid("revoked");
        await recordAuthEvent(tx, {
          space: "portal",
          method: "ticket",
          subjectId: principal.merchantUserId,
          event: "logout",
          at: now,
          ip: meta.ip,
          userAgent: meta.userAgent,
          detail: { sessionId: principal.sessionId, requestId: meta.requestId },
        });
      });
    },
  };
}
export type PortalSessions = ReturnType<typeof createPortalSessions>;
