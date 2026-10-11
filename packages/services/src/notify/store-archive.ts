// 两种归档通知只认持久化来源，不能由 vars 或调用方声明取得账号级例外。
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { lockRows, notifyReadOf } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { Notification } from "@liyoxi/db";
import type { NotificationSpec, NotifyDispatchDeps, NotifyFact } from "./context.js";
import { EVENT_SCENES, NotifyFactSchema } from "./registry.js";

export async function storeArchiveSource(tx: Tx, id: string | null) {
  if (!id) return null;
  const row = await tx.outboxEvent.findUnique({ where: { id } });
  if (!row?.entityId || !row.storeId) return null;
  if (row.eventType === "store.archived") {
    const p = EVENT_PAYLOAD_SCHEMAS["store.archived"].parse(row.payload);
    if (
      p.archiveReason === "by_owner" &&
      p.transition === "store.archive" &&
      p.entityId === row.entityId &&
      p.storeId === row.storeId &&
      row.aggregateType === "store" &&
      row.aggregateId === p.storeId
    )
      return { type: row.eventType, entityId: row.entityId, storeId: row.storeId, memberId: null };
  }
  if (row.eventType === "entity_member.removed") {
    const p = EVENT_PAYLOAD_SCHEMAS["entity_member.removed"].parse(row.payload);
    if (
      p.removeReason === "store_archived" &&
      p.transition === "entity_member.cascade_remove" &&
      p.role === "clerk" &&
      p.entityId === row.entityId &&
      row.aggregateType === "entity_member" &&
      row.aggregateId === p.entityMemberId
    )
      return {
        type: row.eventType,
        entityId: row.entityId,
        storeId: row.storeId,
        memberId: p.entityMemberId,
      };
  }
  return null;
}
export async function storeArchiveNotifications(tx: Tx, deps: NotifyDispatchDeps, eventId: string) {
  const found = await notifyReadOf(deps.assembly).read<{
    personal: unknown;
    owner: unknown;
    manager: unknown;
  }>(tx, "storeArchiveForNotify", eventId);
  const result: { spec: NotificationSpec; fact: NotifyFact }[] = [];
  if (!found) return result;
  for (const key of ["personal", "owner", "manager"] as const) {
    if (!found[key]) continue;
    const fact = NotifyFactSchema.parse(found[key]);
    const base = EVENT_SCENES[key === "manager" ? "store.archived" : "entity_member.removed"]?.[0];
    if (!base) throw new TypeError("门店归档通知未登记");
    const spec: NotificationSpec =
      key === "owner"
        ? {
            ...base,
            ownerOnly: true,
            link: (v) => ({ route: "store.members", params: { storeId: v.storeId! } }),
          }
        : base;
    result.push({ spec, fact });
  }
  return result;
}
/** undefined 保留原场景分支；null 明确拒绝本片来源不完整的外发。 */
export async function currentStoreArchiveNotification(
  tx: Tx,
  deps: NotifyDispatchDeps,
  n: Notification,
) {
  if (!["m.member_changed", "s.merchant_changed"].includes(n.notifySceneKey)) return undefined;
  const source = n.sourceOutboxEventId
    ? await tx.outboxEvent.findUnique({ where: { id: n.sourceOutboxEventId } })
    : null;
  if (
    n.notifySceneKey === "m.member_changed" &&
    source?.eventType === "entity_member.stores_changed"
  )
    return undefined;
  if (!source || !(await storeArchiveSource(tx, source.id))) return null;
  const parts = await storeArchiveNotifications(tx, deps, source.id);
  return (
    parts.find(
      ({ spec, fact }) =>
        spec.sceneKey === n.notifySceneKey &&
        fact.bizType === n.bizType &&
        fact.bizId === n.bizId &&
        fact.entityId === n.entityId &&
        fact.storeId === n.storeId &&
        (n.merchantUserId
          ? fact.merchantUserIds?.includes(n.merchantUserId)
          : n.staffId && fact.staffIds?.includes(n.staffId)),
    ) ?? null
  );
}
/** 在身份90之后、领域100之前发现来源；账号级消息也锁其真实旧主体/成员/门店。 */
export async function lockStoreArchiveSource(tx: Tx, n: Notification) {
  if (!["m.member_changed", "s.merchant_changed"].includes(n.notifySceneKey)) return;
  const source = await storeArchiveSource(tx, n.sourceOutboxEventId);
  if (!source) return;
  await lockRows(tx, "entity", [source.entityId], "share");
  const ids = await tx.entityMember.findMany({
    where: {
      entityId: source.entityId,
      OR: [
        { id: source.memberId ?? "00000000-0000-0000-0000-000000000000" },
        ...(n.merchantUserId ? [{ merchantUserId: n.merchantUserId }] : []),
      ],
    },
    select: { id: true },
  });
  await lockRows(tx, "entity_member", ids.map((row) => row.id).sort(), "share");
  await lockRows(
    tx,
    "store",
    [...new Set([source.storeId, ...(n.storeId ? [n.storeId] : [])])].sort(),
    "share",
  );
}
