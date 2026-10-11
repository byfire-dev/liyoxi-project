import type { Tx } from "../kernel/index.js";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
export interface NotifyRecipientsQuery {
  entityId: string | null;
  storeId: string | null;
  ownerOnly: boolean;
  userIds?: readonly string[];
  allEntities?: boolean;
}

/** 范围调整通知只读当前有效店员与其仍可进入的门店，不能沿事件旧门店筛收件人。 */
export async function memberStoresForNotify(tx: Tx, id: string) {
  const row = await tx.entityMember.findFirst({
    where: {
      id,
      status: "active",
      role: "clerk",
      entity: { lifecycle: "active" },
      merchantUser: { status: "active" },
    },
    select: {
      id: true,
      entityId: true,
      merchantUserId: true,
      displayName: true,
      lastStoreId: true,
      merchantUser: { select: { displayName: true } },
      storeMemberships: {
        where: { store: { lifecycle: "active" } },
        select: { storeId: true },
        orderBy: [{ store: { createdAt: "asc" } }, { storeId: "asc" }],
      },
    },
  });
  if (!row) return null;
  const entry =
    row.storeMemberships.find((store) => store.storeId === row.lastStoreId) ??
    row.storeMemberships[0];
  if (!entry) return null;
  return {
    bizType: "entity_member",
    bizId: row.id,
    entityId: row.entityId,
    storeId: entry.storeId,
    status: "active",
    version: 0,
    name: row.displayName ?? row.merchantUser.displayName ?? "店员",
    merchantUserIds: [row.merchantUserId],
    summary: "所属门店已调整，请查看当前门店范围。",
  };
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

/** 只凭持久化源事件与真实迁移历史投影；无账号/旧门店业务隐私字段。 */
export async function storeArchiveForNotify(tx: Tx, sourceId: string) {
  const source = await tx.outboxEvent.findUnique({ where: { id: sourceId } });
  if (!source?.storeId || !source.entityId) return null;
  const store = await tx.store.findUnique({
    where: { id: source.storeId },
    include: { entity: true, deliveryManager: { select: { id: true, status: true } } },
  });
  if (
    store?.entityId !== source.entityId ||
    store.lifecycle !== "archived" ||
    store.archiveReason !== "by_owner" ||
    !store.archivedAt ||
    store.entity.lifecycle !== "active"
  )
    return null;
  const archive = await tx.statusTransition.findFirst({
    where: {
      machine: "store",
      subjectId: store.id,
      stateField: "lifecycle",
      event: "store.archive",
      toState: "archived",
      reasonCode: "by_owner",
      entityId: store.entityId,
      storeId: store.id,
      actorType: "merchant",
      client: "weapp",
    },
  });
  if (!archive) return null;
  const common = { version: 0, name: "成员状态变更", status: "removed" };
  if (source.eventType === "store.archived") {
    const p = EVENT_PAYLOAD_SCHEMAS["store.archived"].parse(source.payload);
    if (
      p.storeId !== store.id ||
      p.entityId !== store.entityId ||
      p.archiveReason !== "by_owner" ||
      p.transition !== "store.archive" ||
      source.aggregateType !== "store" ||
      source.aggregateId !== store.id ||
      source.actorType !== "merchant" ||
      source.actorId !== archive.actorId ||
      source.requestId !== archive.requestId
    )
      return null;
    return {
      personal: null,
      owner: null,
      manager: {
        ...common,
        bizType: "store",
        bizId: store.id,
        entityId: store.entityId,
        storeId: store.id,
        status: "archived",
        name: "门店已停用",
        summary: "商家已停用门店，请查看当前主体信息。",
        staffIds: store.deliveryManager?.status === "active" ? [store.deliveryManager.id] : [],
      },
    };
  }
  if (source.eventType !== "entity_member.removed") return null;
  const p = EVENT_PAYLOAD_SCHEMAS["entity_member.removed"].parse(source.payload);
  if (
    p.removeReason !== "store_archived" ||
    p.role !== "clerk" ||
    p.transition !== "entity_member.cascade_remove" ||
    p.entityId !== store.entityId ||
    source.aggregateType !== "entity_member" ||
    source.aggregateId !== p.entityMemberId ||
    source.actorType !== "system" ||
    source.actorId !== null ||
    source.client !== null ||
    source.requestId !== archive.requestId
  )
    return null;
  const member = await tx.entityMember.findUnique({
    where: { id: p.entityMemberId },
    include: { merchantUser: { select: { status: true } } },
  });
  if (
    member?.entityId !== p.entityId ||
    member.merchantUserId !== p.merchantUserId ||
    member.role !== "clerk" ||
    member.status !== "removed" ||
    member.removeReason !== "store_archived" ||
    member.removeActorType !== "system"
  )
    return null;
  if (
    !(await tx.statusTransition.findFirst({
      where: {
        machine: "entity_member",
        subjectId: member.id,
        stateField: "status",
        event: "entity_member.cascade_remove",
        fromState: "active",
        toState: "removed",
        reasonCode: "store_archived",
        entityId: store.entityId,
        storeId: store.id,
        actorType: "system",
        requestId: source.requestId,
      },
    }))
  )
    return null;
  const boss = await tx.entityMember.findFirst({
    where: {
      entityId: store.entityId,
      role: "owner",
      status: "active",
      merchantUser: { status: "active" },
    },
    select: { merchantUserId: true, lastStoreId: true },
  });
  const entries = await tx.store.findMany({
    where: { entityId: store.entityId, lifecycle: "active" },
    select: { id: true },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const entry = entries.find((row) => row.id === boss?.lastStoreId) ?? entries[0];
  return {
    manager: null,
    personal:
      member.merchantUser.status === "active"
        ? {
            ...common,
            bizType: "merchant_user",
            bizId: member.merchantUserId,
            entityId: null,
            storeId: null,
            merchantUserIds: [member.merchantUserId],
            summary: "所属门店已停用，您的店员成员关系已结束。",
          }
        : null,
    owner:
      boss && entry
        ? {
            ...common,
            bizType: "entity_member",
            bizId: member.id,
            entityId: store.entityId,
            storeId: entry.id,
            merchantUserIds: [boss.merchantUserId],
            summary: "门店停用后，店员成员关系已相应调整。",
          }
        : null,
  };
}
