import { randomUUID } from "node:crypto";
import { IdSchema } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { diffSnapshots, snapshotTables } from "../data/snapshot.js";
import type { TablesSnapshot } from "../data/snapshot.js";

export const PORTAL_LIVE_READ_TABLES = [
  "portal_ticket",
  "portal_session",
  "auth_event",
  "audit_log",
  "outbox_event",
  "status_transition",
  "idempotency_record",
] as const;
export const PORTAL_PREVIEW_READ_TABLES = [
  ...PORTAL_LIVE_READ_TABLES,
  "ad",
  "ad_version",
  "playable_asset",
  "file_object",
  "file_ref",
  "license_letter",
  "license_letter_revision",
  "timer",
  "delivery_download_log",
] as const;

export interface PortalLiveTicketFact {
  portalTicketId: string;
  storedStatus: "pending" | "approved" | "rejected" | "consumed";
  sessions: readonly {
    portalSessionId: string;
    approvedByUserId: string;
    entityId: string;
    storeId: string;
    revoked: boolean;
  }[];
}

/** Raw snapshots never leave this closure, including when a comparison fails. */
export function createPortalLiveObservations(db: PrismaClient) {
  let window: { id: string; before: TablesSnapshot } | undefined;
  let reading = false;
  let tables: readonly string[] = PORTAL_LIVE_READ_TABLES;
  return {
    enablePreviewReadTables() {
      if (window || reading) throw new Error("READ_WINDOW_ACTIVE");
      tables = PORTAL_PREVIEW_READ_TABLES;
    },
    async beginReadWindow() {
      if (window || reading) throw new Error("READ_WINDOW_ACTIVE");
      reading = true;
      try {
        const before = await snapshotTables(db, tables);
        const id = randomUUID();
        window = { id, before };
        return id;
      } finally {
        reading = false;
      }
    },
    async endReadWindow(id: string) {
      if (!window || window.id !== id || reading) throw new Error("READ_WINDOW_MISMATCH");
      const current = window;
      reading = true;
      try {
        const after = await snapshotTables(db, tables);
        const result = diffSnapshots(current.before, after);
        return { unchanged: result.equal, changedTables: result.tables.map((item) => item.table) };
      } finally {
        window = undefined;
        reading = false;
      }
    },
    discardReadWindow() {
      if (reading) throw new Error("READ_WINDOW_BUSY");
      const discarded = window !== undefined;
      window = undefined;
      return discarded;
    },
    async ticketFacts(ids: readonly string[]): Promise<readonly PortalLiveTicketFact[]> {
      if (
        ids.length > 8 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !IdSchema.safeParse(id).success)
      )
        throw new Error("INVALID_TICKET_SCOPE");
      if (!ids.length) return [];
      const tickets = await db.portalTicket.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, status: true },
        orderBy: { id: "asc" },
      });
      const sessions = await db.portalSession.findMany({
        where: { portalTicketId: { in: [...ids] } },
        select: {
          id: true,
          portalTicketId: true,
          approvedByUserId: true,
          entityId: true,
          storeId: true,
          revokedAt: true,
        },
        orderBy: { id: "asc" },
      });
      return tickets.map((ticket) => {
        const status = ticket.status;
        if (
          status !== "pending" &&
          status !== "approved" &&
          status !== "rejected" &&
          status !== "consumed"
        )
          throw new Error("UNEXPECTED_TICKET_STATE");
        return {
          portalTicketId: ticket.id,
          storedStatus: status,
          sessions: sessions
            .filter((session) => session.portalTicketId === ticket.id)
            .map((session) => ({
              portalSessionId: session.id,
              approvedByUserId: session.approvedByUserId,
              entityId: session.entityId,
              storeId: session.storeId,
              revoked: session.revokedAt !== null,
            })),
        };
      });
    },
  };
}
