// notify 自有只读仓储：不导入 tenant/identity。每条消息读写 SQL 重验当前成员关系。
import { Prisma } from "@liyoxi/db";
import { assertCapability, standingOf } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, isUuid } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface MessageActor {
  merchantUserId: string;
  storeId: string | null;
}
export interface MessageScope extends MessageActor {
  entityId: string | null;
  allStores: boolean;
}

// 别名 st 固定由本模块拥有，不接受外来 SQL 标识。归档仅老板自己停用可进入。
function memberAt(userId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM entity_member em JOIN entity e ON e.id = em.entity_id
    WHERE em.entity_id = st.entity_id AND em.merchant_user_id = ${userId}::uuid
      AND em.status = 'active' AND e.lifecycle = 'active'
      AND ((em.role = 'owner' AND (st.lifecycle = 'active' OR
            (st.lifecycle = 'archived' AND st.archive_reason = 'by_owner')))
        OR (em.role = 'clerk' AND st.lifecycle = 'active' AND EXISTS (
          SELECT 1 FROM store_member sm WHERE sm.entity_member_id = em.id AND sm.store_id = st.id))))`;
}

export function availableStores(userId: string, entityId: string): Prisma.Sql {
  return Prisma.sql`SELECT st.id FROM store st
    WHERE st.entity_id = ${entityId}::uuid AND ${memberAt(userId)}`;
}

export async function messageScope(
  tx: Tx,
  actor: MessageActor,
  allStores: boolean,
): Promise<MessageScope> {
  if (!isUuid(actor.merchantUserId)) throw new AppError("NOT_A_MEMBER");
  if (actor.storeId === null) return { ...actor, entityId: null, allStores };
  if (!isUuid(actor.storeId)) throw new AppError("NOT_A_MEMBER");
  const [row] = await tx.$queryRaw<
    { entityId: string; role: "owner" | "clerk"; lifecycle: string }[]
  >`
    SELECT st.entity_id::text AS "entityId", em.role, st.lifecycle
    FROM store st JOIN entity_member em ON em.entity_id = st.entity_id
      AND em.merchant_user_id = ${actor.merchantUserId}::uuid AND em.status = 'active'
    WHERE st.id = ${actor.storeId}::uuid AND ${memberAt(actor.merchantUserId)}`;
  if (!row) throw new AppError("NOT_A_MEMBER");
  assertCapability(
    standingOf(row.role, row.lifecycle === "active" ? "active" : "archived"),
    "message.read",
  );
  return { ...actor, entityId: row.entityId, allStores };
}

/** 固定 alias m；所有 SELECT/UPDATE 共用，角色、门店变化不能复用旧解析结果授权。 */
export function visibleMessages(scope: MessageScope): Prisma.Sql {
  const current =
    scope.storeId === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`EXISTS (
    SELECT 1 FROM store st WHERE st.id = ${scope.storeId}::uuid
      AND st.entity_id = ${scope.entityId}::uuid AND ${memberAt(scope.merchantUserId)})`;
  const entity =
    scope.entityId === null
      ? Prisma.sql`m.entity_id IS NULL`
      : Prisma.sql`(
    m.entity_id IS NULL OR m.entity_id = ${scope.entityId}::uuid)`;
  const store =
    scope.entityId === null
      ? Prisma.sql`m.store_id IS NULL`
      : Prisma.sql`(
    m.store_id IS NULL OR (m.store_id IN (${availableStores(scope.merchantUserId, scope.entityId)})
      AND (${scope.allStores} OR m.store_id = ${scope.storeId}::uuid)))`;
  return Prisma.sql`m.merchant_user_id = ${scope.merchantUserId}::uuid
    AND EXISTS (SELECT 1 FROM merchant_user mu WHERE mu.id = m.merchant_user_id AND mu.status = 'active') AND ${current}
    AND ${entity} AND ${store}
    AND (NOT m.is_owner_only OR EXISTS (
      SELECT 1 FROM entity_member owner JOIN entity e ON e.id = owner.entity_id
      WHERE owner.entity_id = m.entity_id AND owner.merchant_user_id = ${scope.merchantUserId}::uuid
        AND owner.status = 'active' AND owner.role = 'owner' AND e.lifecycle = 'active'))`;
}

export interface UnreadMessageQuery {
  merchantUserId: string;
  entityId: string | null;
  storeIds: readonly string[];
  now: Date;
}

/** 读侧事实多门店为消息 ID 的并集。当前 EXISTS；不相信调用方 viewerRole 或已缓存门店权限。 */
export async function countUnread(tx: Tx, input: UnreadMessageQuery): Promise<number> {
  if (
    !isUuid(input.merchantUserId) ||
    (input.entityId !== null && !isUuid(input.entityId)) ||
    input.storeIds.some((id) => !isUuid(id))
  ) {
    throw new AppError("VALIDATION_FAILED");
  }
  const values = await paramsAt(tx, ["inbox.scope"], input.now);
  const predicates =
    input.entityId === null || input.storeIds.length === 0
      ? [
          visibleMessages({
            merchantUserId: input.merchantUserId,
            storeId: null,
            entityId: null,
            allStores: false,
          }),
        ]
      : [...new Set(input.storeIds)].map((storeId) =>
          visibleMessages({
            merchantUserId: input.merchantUserId,
            entityId: input.entityId,
            storeId,
            allStores: values["inbox.scope"] === "all_stores",
          }),
        );
  const [row] = await tx.$queryRaw<{ count: number }[]>(Prisma.sql`
    SELECT count(*)::int AS count FROM merchant_message m WHERE m.read_at IS NULL
      AND (${Prisma.join(predicates, " OR ")})`);
  if (!row) throw new Error("未读聚合查询未返回结果");
  return row.count;
}
