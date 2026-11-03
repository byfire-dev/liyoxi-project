import { defineRegistration } from "../kernel/index.js";
import type { CleanupContext, InvariantViolation, Tx } from "../kernel/index.js";

/** Existing ops.retention invokes this bounded cleanup; expiration is never a ticket write. */
export function purgePortalTickets(tx: Tx, { now, limit }: CleanupContext): Promise<number> {
  return tx.$executeRaw`DELETE FROM portal_ticket WHERE id IN (
    SELECT id FROM portal_ticket WHERE created_at < ${new Date(now.getTime() - 7 * 86_400_000)}
    ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
}
export async function findI31Violations(tx: Tx): Promise<InvariantViolation[]> {
  const rows = await tx.$queryRaw<{ id: string; entityId: string | null; count: number }[]>`
    SELECT t.id, t.entity_id AS "entityId", count(s.id)::int AS count
    FROM portal_ticket t LEFT JOIN portal_session s ON s.portal_ticket_id=t.id
    WHERE t.status='consumed' GROUP BY t.id HAVING count(s.id)<>1 ORDER BY t.id LIMIT 200`;
  return rows.map((row) => ({
    subject: { type: "portal_ticket", id: row.id },
    ...(row.entityId ? { entityId: row.entityId } : {}),
    detail: { sessions: row.count },
  }));
}
export const registration = defineRegistration("portal", {
  cleanups: [{ name: "portal.portal_ticket", every: "day", run: purgePortalTickets }],
  invariants: [
    { code: "portal.I31", severity: "P2", modes: ["full"], heal: "none", run: findI31Violations },
  ],
});
