import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { uuidv7 } from "../../kernel/index.js";
import type * as SnapshotModule from "../data/snapshot.js";
const read = vi.hoisted(() => vi.fn());
vi.mock("../data/snapshot.js", async (original) => ({
  ...(await original<typeof SnapshotModule>()),
  snapshotTables: read,
}));
import {
  createPortalLiveObservations,
  PORTAL_LIVE_READ_TABLES,
  PORTAL_PREVIEW_READ_TABLES,
} from "./observations.js";

it("enables the preview business tables only between windows, retaining every original table", async () => {
  read.mockReset().mockResolvedValue({});
  const observations = createPortalLiveObservations({} as PrismaClient);
  const original = await observations.beginReadWindow();
  expect(() => observations.enablePreviewReadTables()).toThrow("READ_WINDOW_ACTIVE");
  await observations.endReadWindow(original);
  observations.enablePreviewReadTables();
  const next = await observations.beginReadWindow();
  await observations.endReadWindow(next);
  expect(PORTAL_PREVIEW_READ_TABLES).toEqual(expect.arrayContaining([...PORTAL_LIVE_READ_TABLES]));
  expect(read.mock.calls.map((call) => call[1])).toEqual([
    PORTAL_LIVE_READ_TABLES,
    PORTAL_LIVE_READ_TABLES,
    PORTAL_PREVIEW_READ_TABLES,
    PORTAL_PREVIEW_READ_TABLES,
  ]);
});

it("compares all seven full tables without emitting secret row values or ignoring columns", async () => {
  const before = Object.fromEntries(
    PORTAL_LIVE_READ_TABLES.map((table) => [
      table,
      {
        table,
        keyColumns: ["id"],
        rows: [{ id: "row", token_hash: "private-hash-sentinel", updated_at: "before" }],
      },
    ]),
  );
  const after = structuredClone(before);
  after.portal_session!.rows[0]!.updated_at = "after";
  read.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  const observations = createPortalLiveObservations({} as PrismaClient);
  const window = await observations.beginReadWindow();
  await expect(observations.beginReadWindow()).rejects.toThrow("READ_WINDOW_ACTIVE");
  await expect(observations.endReadWindow(randomUUID())).rejects.toThrow("READ_WINDOW_MISMATCH");
  const result = await observations.endReadWindow(window);
  expect(result).toEqual({ unchanged: false, changedTables: ["portal_session"] });
  expect(JSON.stringify(result)).not.toContain("private-hash-sentinel");
  expect(read.mock.calls.map((call) => call[1])).toEqual([
    PORTAL_LIVE_READ_TABLES,
    PORTAL_LIVE_READ_TABLES,
  ]);
  expect(observations.discardReadWindow()).toBe(false);
});

it("ticket observations select only public ownership facts, never either secret hash", async () => {
  const ticket = uuidv7(),
    session = uuidv7();
  const db = {
    portalTicket: { findMany: vi.fn().mockResolvedValue([{ id: ticket, status: "consumed" }]) },
    portalSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: session,
          portalTicketId: ticket,
          approvedByUserId: uuidv7(),
          entityId: uuidv7(),
          storeId: uuidv7(),
          revokedAt: null,
        },
      ]),
    },
  };
  const observations = createPortalLiveObservations(db as unknown as PrismaClient);
  const result = await observations.ticketFacts([ticket]);
  expect(result[0]?.sessions[0]).toMatchObject({ portalSessionId: session, revoked: false });
  const queries = JSON.stringify([
    db.portalTicket.findMany.mock.calls,
    db.portalSession.findMany.mock.calls,
  ]);
  expect(queries).not.toMatch(/pollSecretHash|tokenHash/);
  await expect(observations.ticketFacts([ticket, ticket])).rejects.toThrow("INVALID_TICKET_SCOPE");
  await expect(observations.ticketFacts([randomUUID()])).rejects.toThrow("INVALID_TICKET_SCOPE");
  expect(db.portalTicket.findMany).toHaveBeenCalledTimes(1);
});
