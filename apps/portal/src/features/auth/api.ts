import type { components } from "@liyoxi/contract/types/portal";

import type { PortalClient } from "../../lib/api";
import { object, PortalApiError } from "../../lib/api-errors";
import { readPortalSession } from "../session/api";

export type PublicPortalTicket = Omit<components["schemas"]["PortalTicketCreated"], "pollSecret">;
export type PortalTicketStatus = components["schemas"]["PortalTicketStatusView"];
export type PortalTicketExchange = components["schemas"]["PortalTicketExchangeResult"];
export interface PortalTicketFlow {
  create(signal?: AbortSignal): Promise<PublicPortalTicket>;
  poll(signal?: AbortSignal): Promise<PortalTicketStatus>;
  exchange(signal?: AbortSignal): Promise<PortalTicketExchange>;
  dispose(): void;
}

/** One ticket generation, with the secret held solely in this closure. No automatic polling or writes. */
export function createPortalTicketFlow(client: PortalClient): PortalTicketFlow {
  let generation = 0;
  let secret: string | null = null;
  let ticket: PublicPortalTicket | null = null;
  let terminal = false;
  let disposed = false;
  let controller = new AbortController();
  let exchanging: Promise<PortalTicketExchange> | null = null;
  const signalFor = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const active = () => {
    if (disposed) throw new PortalApiError("CLIENT_DISPOSED");
  };
  const current = (revision: number) => {
    if (disposed || revision !== generation) throw new PortalApiError("REQUEST_ABORTED");
  };
  return {
    async create(signal) {
      active();
      controller.abort();
      controller = new AbortController();
      const revision = ++generation;
      secret = null;
      ticket = null;
      terminal = false;
      exchanging = null;
      const data = await client.request("/api/v1/portal/portal-tickets", "post", {
        body: {},
        signal: signalFor(signal),
      });
      current(revision);
      if (
        !data ||
        typeof data.pollSecret !== "string" ||
        typeof data.qrUrl !== "string" ||
        typeof data.expiresAt !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(data.pollSecret) ||
        !/^[0-9a-f-]{36}$/i.test(data.portalTicketId) ||
        !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(data.shortCode) ||
        !/^\d{2}$/.test(data.pairDigits) ||
        data.pollIntervalMs !== 2000 ||
        !Number.isFinite(Date.parse(data.expiresAt))
      )
        throw new PortalApiError("INVALID_RESPONSE");
      let qr: URL;
      try {
        qr = new URL(data.qrUrl);
      } catch {
        throw new PortalApiError("INVALID_RESPONSE");
      }
      if (
        !/^https?:$/.test(qr.protocol) ||
        qr.username ||
        qr.password ||
        data.qrUrl.includes(data.pollSecret)
      ) {
        throw new PortalApiError("INVALID_RESPONSE");
      }
      secret = data.pollSecret;
      ticket = Object.freeze({
        portalTicketId: data.portalTicketId,
        qrUrl: data.qrUrl,
        shortCode: data.shortCode,
        pairDigits: data.pairDigits,
        expiresAt: data.expiresAt,
        pollIntervalMs: data.pollIntervalMs,
      });
      return ticket;
    },
    async poll(signal) {
      active();
      if (!ticket || !secret || terminal) throw new PortalApiError("PORTAL_TICKET_INVALID", 410);
      const revision = generation;
      const data = await client.request("/api/v1/portal/portal-tickets/{portalTicketId}", "get", {
        path: { portalTicketId: ticket.portalTicketId },
        pollSecret: secret,
        signal: signalFor(signal),
      });
      current(revision);
      if (
        !data ||
        data.portalTicketId !== ticket.portalTicketId ||
        !["pending", "approved", "rejected", "expired", "consumed"].includes(data.status) ||
        !Number.isFinite(Date.parse(data.expiresAt))
      )
        throw new PortalApiError("INVALID_RESPONSE");
      if (["rejected", "expired", "consumed"].includes(data.status)) {
        terminal = true;
        secret = null;
      }
      return {
        portalTicketId: data.portalTicketId,
        status: data.status,
        expiresAt: data.expiresAt,
      };
    },
    exchange(signal) {
      active();
      if (exchanging) return exchanging;
      if (!ticket || !secret || terminal)
        return Promise.reject(new PortalApiError("PORTAL_TICKET_INVALID", 410));
      const revision = generation;
      const id = ticket.portalTicketId;
      const pollSecret = secret;
      exchanging = (async () => {
        try {
          const data = await client.request(
            "/api/v1/portal/portal-tickets/{portalTicketId}/exchange",
            "post",
            {
              path: { portalTicketId: id },
              body: { pollSecret },
              signal: signalFor(signal),
            },
          );
          current(revision);
          const value = object(data);
          if (!value || (value.status !== "consumed" && value.status !== "rejected"))
            throw new PortalApiError("INVALID_RESPONSE");
          const session = readPortalSession(value.session);
          if (value.status === "consumed") {
            if (!session || value.rejectReason !== null)
              throw new PortalApiError("INVALID_RESPONSE");
            return { status: "consumed" as const, session, rejectReason: null };
          }
          if (
            session !== null ||
            !["secret_mismatch", "attempts_exceeded", "window_passed"].includes(
              String(value.rejectReason),
            )
          ) {
            throw new PortalApiError("INVALID_RESPONSE");
          }
          return {
            status: "rejected" as const,
            session: null,
            rejectReason: value.rejectReason as PortalTicketExchange["rejectReason"],
          };
        } finally {
          if (revision === generation) {
            secret = null;
            terminal = true;
          }
        }
      })();
      return exchanging;
    },
    dispose() {
      disposed = true;
      generation += 1;
      controller.abort();
      secret = null;
      ticket = null;
      exchanging = null;
    },
  };
}
