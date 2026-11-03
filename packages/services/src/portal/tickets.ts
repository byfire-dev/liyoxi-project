import { createHash, randomBytes, randomInt } from "node:crypto";
import type {
  PortalTicketCreated,
  PortalTicketDecision,
  PortalTicketExchangeResult,
  PortalTicketPreview,
  PortalTicketStatusView,
} from "@liyoxi/contract";
import type { PortalTicket } from "@liyoxi/db";
import { record as recordAudit, recordAuthEvent } from "../audit/index.js";
import {
  assertPortalOwner,
  createPortalSession,
  newPortalSecret,
  portalBrowser,
  portalSecretHash,
  portalSecretMatches,
} from "../identity/index.js";
import type { PortalOwnerRequest, PortalSessionDeps, RequestMeta } from "../identity/index.js";
import { AppError, isUniqueViolation, savepoint, uuidv7 } from "../kernel/index.js";
import type { IdempotencyContext, Tx } from "../kernel/index.js";

export interface PortalTicketDeps extends PortalSessionDeps {
  readonly origin?: string;
  readonly ticketTtlSeconds: number;
}
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function invalid(reason: string): never {
  throw new AppError("PORTAL_TICKET_INVALID", { details: { reason } });
}
function assertPending(ticket: PortalTicket | null, now: Date): asserts ticket is PortalTicket {
  if (!ticket) invalid("not_found");
  if (ticket.status === "rejected" || ticket.status === "consumed") invalid(ticket.status);
  if (ticket.status === "approved") {
    if (!ticket.approvedAt || now.getTime() > ticket.approvedAt.getTime() + 60_000)
      invalid("expired");
    invalid("approved");
  }
  if (now.getTime() >= ticket.expiresAt.getTime()) invalid("expired");
}
/** Stable, distinct choices; no mutation during GET and no exposure of which choice is correct. */
export function portalPairChoices(id: string, correct: string): string[] {
  const hash = createHash("sha256").update(id).digest();
  const choices = new Set([correct]);
  let n = hash.readUInt16BE(0) % 100;
  while (choices.size < 3) {
    choices.add(n.toString().padStart(2, "0"));
    n = (n + 37) % 100;
  }
  return [...choices].sort((a, b) =>
    createHash("sha256")
      .update(id + a)
      .digest("hex")
      .localeCompare(
        createHash("sha256")
          .update(id + b)
          .digest("hex"),
      ),
  );
}
async function afterLostRace(tx: Tx, id: string, now: Date): Promise<never> {
  assertPending(await tx.portalTicket.findUnique({ where: { id } }), now);
  throw new AppError("BUSY");
}

export function createPortalTickets(deps: PortalTicketDeps) {
  if (!Number.isSafeInteger(deps.ticketTtlSeconds) || deps.ticketTtlSeconds <= 0)
    throw new TypeError("PORTAL_TICKET_TTL 必须是正整数秒");
  return {
    async create(meta: RequestMeta): Promise<PortalTicketCreated> {
      if (!deps.origin) throw new AppError("PROVIDER_UNAVAILABLE");
      return deps.tx.run(async (tx) => {
        // Collision retries are savepoint-scoped; a failed INSERT never poisons the transaction.
        for (let attempt = 0; attempt < 5; attempt++) {
          const now = deps.clock.now();
          const pollSecret = newPortalSecret();
          const publicId = randomBytes(16).toString("base64url");
          const shortCode = Array.from(randomBytes(8), (byte) => CROCKFORD[byte % 32]).join("");
          const pairDigits = randomInt(100).toString().padStart(2, "0");
          try {
            const ticket = await savepoint(tx, () =>
              tx.portalTicket.create({
                data: {
                  id: uuidv7(),
                  publicId,
                  shortCode,
                  pairDigits,
                  pollSecretHash: portalSecretHash(pollSecret),
                  status: "pending",
                  createdAt: now,
                  updatedAt: now,
                  expiresAt: new Date(now.getTime() + deps.ticketTtlSeconds * 1000),
                  ip: meta.ip ?? "",
                  userAgent: (meta.userAgent ?? "").slice(0, 512),
                },
              }),
            );
            return {
              portalTicketId: ticket.id,
              qrUrl: `${deps.origin}/a?t=${publicId}`,
              shortCode,
              pairDigits,
              pollSecret,
              expiresAt: ticket.expiresAt.toISOString(),
              pollIntervalMs: 2000,
            };
          } catch (error) {
            if (
              !isUniqueViolation(error, [
                "uq_portal_ticket_public_id",
                "uq_portal_ticket_short_code_pending",
              ])
            )
              throw error;
          }
        }
        throw new AppError("BUSY");
      });
    },
    async poll(id: string, secret: string): Promise<PortalTicketStatusView> {
      return deps.tx.run(async (tx) => {
        const ticket = await tx.portalTicket.findUnique({ where: { id } });
        if (!ticket || !portalSecretMatches(secret, ticket.pollSecretHash))
          throw new AppError("NOT_FOUND");
        const now = deps.clock.now();
        const expired =
          ticket.status === "pending"
            ? now.getTime() >= ticket.expiresAt.getTime()
            : ticket.status === "approved" &&
              (!ticket.approvedAt || now.getTime() > ticket.approvedAt.getTime() + 60_000);
        return {
          portalTicketId: ticket.id,
          status: expired ? "expired" : (ticket.status as PortalTicketStatusView["status"]),
          expiresAt: ticket.expiresAt.toISOString(),
        };
      });
    },
    async lookup(request: PortalOwnerRequest, code: string): Promise<PortalTicketPreview> {
      return deps.tx.run(async (tx) => {
        const owner = await assertPortalOwner(tx, request, deps.clock, deps.appid);
        const ticket = /^[A-Za-z0-9_-]{22}$/.test(code)
          ? await tx.portalTicket.findUnique({ where: { publicId: code } })
          : await tx.portalTicket.findFirst({
              where: { shortCode: code.replace(/[\s-]/g, "").toUpperCase(), status: "pending" },
            });
        assertPending(ticket, deps.clock.now());
        return {
          portalTicketId: ticket.id,
          browser: portalBrowser(ticket.userAgent),
          regionHint: null,
          createdAt: ticket.createdAt.toISOString(),
          expiresAt: ticket.expiresAt.toISOString(),
          pairChoices: portalPairChoices(ticket.id, ticket.pairDigits),
          storeId: owner.storeId,
          storeName: owner.storeName,
        };
      });
    },
    async decide(
      request: PortalOwnerRequest,
      id: string,
      pairDigits: string | null,
      options: { idem?: IdempotencyContext } = {},
    ): Promise<PortalTicketDecision> {
      return deps.tx.run(async (tx) => {
        const owner = await assertPortalOwner(tx, request, deps.clock, deps.appid, true);
        await tx.$queryRaw`SELECT id FROM portal_ticket WHERE id=${id}::uuid FOR UPDATE`;
        // A logout may revoke user_session while this technical row lock was waiting.
        await assertPortalOwner(tx, request, deps.clock, deps.appid);
        const ticket = await tx.portalTicket.findUnique({ where: { id } });
        const now = deps.clock.now();
        assertPending(ticket, now);
        const approved = pairDigits !== null && pairDigits === ticket.pairDigits;
        const result: PortalTicketDecision = {
          portalTicketId: id,
          status: approved ? "approved" : "rejected",
          approvedAt: approved ? now.toISOString() : null,
          storeId: approved ? owner.storeId : null,
          rejectReason: approved ? null : pairDigits === null ? "by_owner" : "pair_mismatch",
        };
        const changed = await tx.portalTicket.updateMany({
          where: { id, status: "pending", expiresAt: { gt: now } },
          data: {
            status: result.status,
            updatedAt: now,
            ...(approved
              ? {
                  approvedAt: now,
                  approvedByUserId: owner.merchantUserId,
                  entityId: owner.entityId,
                  storeId: owner.storeId,
                }
              : {}),
          },
        });
        if (!changed.count) return afterLostRace(tx, id, deps.clock.now());
        if (pairDigits !== null)
          await recordAudit(
            tx,
            request.ctx.actor,
            { ...request.ctx, authMethod: "weapp", sessionId: request.principal.sessionId },
            {
              stream: "activity",
              category: "account_security",
              action: "portal.ticket.approve",
              summary: approved ? "允许电脑下载" : "配对数字不一致，拒绝电脑授权",
              target: { type: "portal_ticket", id },
              entityId: owner.entityId,
              storeId: owner.storeId,
              meta: { ip: ticket.ip, userAgent: ticket.userAgent },
            },
          );
        return result;
      }, options);
    },
    async exchange(
      id: string,
      secret: string,
      meta: RequestMeta,
    ): Promise<{
      result: PortalTicketExchangeResult;
      token: string | null;
    }> {
      const outcome = await deps.tx.run(async (tx) => {
        await tx.$queryRaw`SELECT id FROM portal_ticket WHERE id=${id}::uuid FOR UPDATE`;
        const ticket = await tx.portalTicket.findUnique({ where: { id } });
        if (!ticket) invalid("not_found");
        if (ticket.status === "consumed" || ticket.status === "rejected") invalid(ticket.status);
        const now = deps.clock.now();
        const matches = portalSecretMatches(secret, ticket.pollSecretHash);
        if (ticket.status === "pending") {
          if (!matches) invalid("secret_mismatch");
          if (now.getTime() >= ticket.expiresAt.getTime()) invalid("expired");
          throw new AppError("STATE_NOT_ALLOWED");
        }
        const rejectReason = !matches
          ? "secret_mismatch"
          : ticket.exchangeAttempts >= 5
            ? "attempts_exceeded"
            : !ticket.approvedAt || now.getTime() > ticket.approvedAt.getTime() + 60_000
              ? "window_passed"
              : null;
        const changed = await tx.portalTicket.updateMany({
          where: { id, status: "approved" },
          data: {
            status: rejectReason ? "rejected" : "consumed",
            exchangeAttempts: { increment: 1 },
            updatedAt: now,
            ...(rejectReason ? {} : { consumedAt: now }),
          },
        });
        if (!changed.count) return afterLostRace(tx, id, deps.clock.now());
        if (rejectReason)
          return {
            result: {
              status: "rejected",
              session: null,
              rejectReason,
            } as PortalTicketExchangeResult,
            token: null,
            subjectId: ticket.approvedByUserId,
          };
        if (!ticket.approvedByUserId || !ticket.entityId || !ticket.storeId)
          throw new TypeError("已确认票据缺少授权范围");
        // p01 explicitly defers current-owner checks to portalAuth, not exchange.
        const session = await createPortalSession(
          tx,
          now,
          {
            portalTicketId: id,
            approvedByUserId: ticket.approvedByUserId,
            entityId: ticket.entityId,
            storeId: ticket.storeId,
          },
          meta,
        );
        return {
          result: {
            status: "consumed",
            session: session.view,
            rejectReason: null,
          } as PortalTicketExchangeResult,
          token: session.token,
          subjectId: ticket.approvedByUserId,
        };
      });
      const failureReason = outcome.result.rejectReason;
      if (failureReason) {
        // A separate transaction, after the irreversible rejection has committed.
        await deps.tx.run((tx) =>
          recordAuthEvent(tx, {
            space: "portal",
            method: "ticket",
            event: "login_fail",
            subjectId: outcome.subjectId,
            at: deps.clock.now(),
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { reason: failureReason, requestId: meta.requestId },
          }),
        );
      }
      return { result: outcome.result, token: outcome.token };
    },
  };
}
export type PortalTickets = ReturnType<typeof createPortalTickets>;
