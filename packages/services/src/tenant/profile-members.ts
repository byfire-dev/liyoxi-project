import type { Tx } from "../kernel/index.js";

export interface StoreMembersBrief {
  readonly ownerDisplayName: string | null;
  readonly clerkCount: number;
  readonly pendingInvitationCount: number;
  readonly preview: { displayName: string | null; role: "owner" | "clerk" }[];
}

/** 首页窄投影：同调用方事务、同一语句快照，不触发过期修复或其他写入。 */
export async function readStoreMembersBrief(
  tx: Tx,
  input: { readonly entityId: string; readonly storeId: string; readonly now: Date },
): Promise<StoreMembersBrief | null> {
  const rows = await tx.$queryRaw<StoreMembersBrief[]>`
    WITH scope AS (
      SELECT st.id, st.entity_id
        FROM store st JOIN entity e ON e.id = st.entity_id
       WHERE st.id = ${input.storeId}::uuid AND st.entity_id = ${input.entityId}::uuid
         AND e.lifecycle = 'active' AND (
           st.lifecycle = 'active' OR
           (st.lifecycle = 'archived' AND st.archive_reason = 'by_owner')
         )
    ), members AS (
      SELECT em.id, em.display_name, em.role, em.created_at
        FROM entity_member em JOIN scope s ON s.entity_id = em.entity_id
       WHERE em.status = 'active' AND (
         em.role = 'owner' OR (em.role = 'clerk' AND EXISTS (
           SELECT 1 FROM store_member sm
            WHERE sm.entity_member_id = em.id AND sm.entity_id = s.entity_id
              AND sm.store_id = s.id
         ))
       )
    ), preview AS (
      SELECT display_name, role, created_at, id FROM members
       ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at, id LIMIT 3
    )
    SELECT (SELECT display_name FROM members WHERE role = 'owner') AS "ownerDisplayName",
           (SELECT count(*)::int FROM members WHERE role = 'clerk') AS "clerkCount",
           (SELECT count(*)::int FROM invitation i
             WHERE i.entity_id = s.entity_id AND i.store_id = s.id
               AND i.status = 'pending' AND i.expires_at > ${input.now})
             AS "pendingInvitationCount",
           COALESCE((SELECT jsonb_agg(
             jsonb_build_object('displayName', display_name, 'role', role)
             ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at, id
           ) FROM preview), '[]'::jsonb) AS preview
      FROM scope s`;
  return rows[0] ?? null;
}
