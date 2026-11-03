import type { InvariantViolation, Tx } from "../kernel/index.js";

/** Report only. Membership-changing transactions own revocation; GET never repairs. */
export async function findI20Violations(tx: Tx, now: Date): Promise<InvariantViolation[]> {
  const rows = await tx.$queryRaw<{ id: string; entityId: string }[]>`
    SELECT s.id, s.entity_id AS "entityId" FROM portal_session s
    JOIN merchant_user u ON u.id=s.approved_by_user_id
    WHERE s.revoked_at IS NULL AND s.expires_at > ${now}
      AND (u.status<>'active' OR NOT EXISTS (
        SELECT 1 FROM entity_member m WHERE m.entity_id=s.entity_id
          AND m.merchant_user_id=s.approved_by_user_id AND m.role='owner' AND m.status='active'))
    ORDER BY s.id LIMIT 200`;
  return rows.map((row) => ({
    subject: { type: "portal_session", id: row.id },
    entityId: row.entityId,
    detail: { reason: "authorizer_invalid" },
  }));
}
