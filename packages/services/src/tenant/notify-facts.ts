import type { Tx } from "../kernel/index.js";
export interface NotifyRecipientsQuery {
  entityId: string | null;
  storeId: string | null;
  ownerOnly: boolean;
  userIds?: readonly string[];
  allEntities?: boolean;
}

/** Announcement fanout uses an ordered, bounded pair cursor, never a full recipient materialization. */
export async function noticeRecipientsPageForNotify(
  tx: Tx,
  input: { after: { merchantUserId: string; entityId: string } | null; take: number },
) {
  if (!Number.isInteger(input.take) || input.take < 1 || input.take > 10_001)
    throw new TypeError("公告接收人页容量不合法");
  return tx.$queryRaw<{ id: string; merchantUserId: string; entityId: string }[]>`
    SELECT em.id, em.merchant_user_id AS "merchantUserId", em.entity_id AS "entityId"
    FROM entity_member em JOIN merchant_user mu ON mu.id = em.merchant_user_id
    JOIN entity e ON e.id = em.entity_id
    WHERE em.status = 'active' AND em.role = 'owner' AND mu.status = 'active'
      AND e.lifecycle = 'active'
      AND (${input.after?.merchantUserId ?? null}::uuid IS NULL OR
        (em.merchant_user_id, em.entity_id) >
        (${input.after?.merchantUserId ?? null}::uuid, ${input.after?.entityId ?? null}::uuid))
    ORDER BY em.merchant_user_id, em.entity_id LIMIT ${input.take}`;
}
/** Current active facts, never the event's role snapshot. */
export async function merchantRecipientsForNotify(tx: Tx, query: NotifyRecipientsQuery) {
  if (
    query.storeId &&
    !(await tx.store.findFirst({
      where: {
        id: query.storeId,
        lifecycle: "active",
        ...(query.entityId ? { entityId: query.entityId } : {}),
      },
      select: { id: true },
    }))
  )
    return [];
  const rows = await tx.entityMember.findMany({
    where: {
      ...(query.allEntities
        ? {}
        : { entityId: query.entityId ?? "00000000-0000-0000-0000-000000000000" }),
      status: "active",
      entity: { lifecycle: "active" },
      merchantUser: { status: "active" },
      ...(query.ownerOnly ? { role: "owner" } : {}),
      ...(query.userIds ? { merchantUserId: { in: [...query.userIds] } } : {}),
      ...(query.storeId
        ? { OR: [{ role: "owner" }, { storeMemberships: { some: { storeId: query.storeId } } }] }
        : {}),
    },
    select: { id: true, merchantUserId: true, entityId: true, role: true },
    orderBy: { merchantUserId: "asc" },
  });
  return rows.filter(
    (row, i) =>
      rows.findIndex(
        (r) => r.merchantUserId === row.merchantUserId && r.entityId === row.entityId,
      ) === i,
  );
}

export async function managerIdsForNotify(
  tx: Tx,
  query: { entityId: string | null; storeId: string | null },
) {
  if (!query.entityId) return [];
  const stores = await tx.store.findMany({
    where: {
      entityId: query.entityId,
      lifecycle: "active",
      ...(query.storeId ? { id: query.storeId } : {}),
      deliveryManager: { status: "active" },
    },
    select: { deliveryManagerId: true },
    orderBy: { id: "asc" },
  });
  return [
    ...new Set(stores.flatMap((row) => (row.deliveryManagerId ? [row.deliveryManagerId] : []))),
  ].sort();
}
