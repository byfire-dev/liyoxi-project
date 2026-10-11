// tenant 不变量（W1-03 与 W2-10；02 分组第 2.9–2.13 节与第 5 节“不变量登记”）。
// 都是 P2，只在 full 运行里查，不自愈；调度与落库由 ops（W0-24）。对象属于主体的带 entityId。
//   tenant.I1   每个 active 主体恰有 1 位有效老板
//   tenant.I7   已认证主体信用代码的唯一索引存在
//   tenant.I27  每个主体恰有一家首店
//   tenant.I29  老板没有 store_member 行
// W2-10 关闭核心补 I17、I28；I5、I30 随成员/邀请完整写侧登记。
import type { InvariantViolation, Tx } from "../kernel/index.js";

type Reader = Pick<Tx, "$queryRaw">;

/** 每条至多报多少个对象 */
export const TENANT_INVARIANT_LIMIT = 200;

/** 有效店员必须仍可进入至少一家启用门店；不自动修复历史。 */
export async function findI5Violations(db: Reader): Promise<InvariantViolation[]> {
  const rows = await db.$queryRaw<{ id: string; entityId: string }[]>`
    SELECT m.id::text, m.entity_id::text AS "entityId" FROM entity_member m
    WHERE m.status = 'active' AND m.role = 'clerk' AND NOT EXISTS (
      SELECT 1 FROM store_member sm JOIN store s ON s.id = sm.store_id
      WHERE sm.entity_member_id = m.id AND s.entity_id = m.entity_id AND s.lifecycle = 'active')
    ORDER BY m.id LIMIT ${TENANT_INVARIANT_LIMIT}`;
  return rows.map((row) => ({
    subject: { type: "entity_member", id: row.id },
    entityId: row.entityId,
    detail: { activeStores: 0 },
  }));
}

export async function findI1Violations(db: Reader): Promise<InvariantViolation[]> {
  const rows = await db.$queryRaw<{ id: string; owners: number }[]>`
    SELECT e.id::text AS id, count(m.id)::int AS owners
      FROM entity e
      LEFT JOIN entity_member m
             ON m.entity_id = e.id AND m.status = 'active' AND m.role = 'owner'
     WHERE e.lifecycle = 'active'
     GROUP BY e.id
    HAVING count(m.id) <> 1
     ORDER BY e.id
     LIMIT ${TENANT_INVARIANT_LIMIT}`;
  return rows.map((row) => ({
    subject: { type: "entity", id: row.id },
    entityId: row.id,
    detail: { expected: 1, activeOwners: row.owners },
  }));
}

/** 唯一索引的名字（02 分组 第 2.9 节手写约束） */
export const USCC_UNIQUE_INDEX = "uq_entity_uscc_bidx_verified";

export async function findI7Violations(db: Reader): Promise<InvariantViolation[]> {
  const rows = await db.$queryRaw<{ found: number }[]>`
    SELECT count(*)::int AS found FROM pg_catalog.pg_indexes
     WHERE schemaname = current_schema() AND tablename = 'entity'
       AND indexname = ${USCC_UNIQUE_INDEX}`;
  return rows[0]?.found === 1
    ? []
    : [{ subject: { key: USCC_UNIQUE_INDEX }, detail: { problem: "unique_index_missing" } }];
}

export async function findI27Violations(db: Reader): Promise<InvariantViolation[]> {
  const rows = await db.$queryRaw<{ id: string; primaries: number }[]>`
    SELECT e.id::text AS id, count(s.id)::int AS primaries
      FROM entity e
      LEFT JOIN store s ON s.entity_id = e.id AND s.is_primary
     GROUP BY e.id
    HAVING count(s.id) <> 1
     ORDER BY e.id
     LIMIT ${TENANT_INVARIANT_LIMIT}`;
  return rows.map((row) => ({
    subject: { type: "entity", id: row.id },
    entityId: row.id,
    detail: { expected: 1, primaryStores: row.primaries },
  }));
}

export async function findI29Violations(db: Reader): Promise<InvariantViolation[]> {
  const rows = await db.$queryRaw<{ id: string; entityId: string; stores: number }[]>`
    SELECT m.id::text AS id, m.entity_id::text AS "entityId", count(*)::int AS stores
      FROM entity_member m
      JOIN store_member sm ON sm.entity_member_id = m.id
     WHERE m.status = 'active' AND m.role = 'owner'
     GROUP BY m.id, m.entity_id
     ORDER BY m.id
     LIMIT ${TENANT_INVARIANT_LIMIT}`;
  return rows.map((row) => ({
    subject: { type: "entity_member", id: row.id },
    entityId: row.entityId,
    detail: { expected: 0, storeMemberRows: row.stores },
  }));
}

/** 终局主体与归档门店不能残留有效授权或待接受邀请（02 第 2.9、2.10、2.13 节）。 */
export async function findI17Violations(db: Reader): Promise<InvariantViolation[]> {
  const rows = await db.$queryRaw<
    {
      id: string;
      entityId: string;
      type: "entity" | "store";
      members: number;
      invitations: number;
      stores: number;
    }[]
  >`
    WITH residuals AS (
      SELECT e.id, e.id AS entity_id, 'entity'::text AS type,
        (SELECT count(*)::int FROM entity_member m WHERE m.entity_id = e.id AND m.status = 'active') AS members,
        (SELECT count(*)::int FROM invitation i WHERE i.entity_id = e.id AND i.status = 'pending') AS invitations,
        (SELECT count(*)::int FROM store s WHERE s.entity_id = e.id AND s.lifecycle = 'active') AS stores
      FROM entity e WHERE e.lifecycle <> 'active'
      UNION ALL
      SELECT s.id, s.entity_id, 'store'::text,
        (SELECT count(*)::int FROM store_member sm WHERE sm.store_id = s.id),
        (SELECT count(*)::int FROM invitation i WHERE i.store_id = s.id AND i.status = 'pending'), 0
      FROM store s WHERE s.lifecycle = 'archived'
    )
    SELECT id::text, entity_id::text AS "entityId", type, members, invitations, stores
      FROM residuals WHERE members + invitations + stores > 0
     ORDER BY type, id LIMIT ${TENANT_INVARIANT_LIMIT}`;
  return rows.map((row) => ({
    subject: { type: row.type, id: row.id },
    entityId: row.entityId,
    detail: { members: row.members, pendingInvitations: row.invitations, activeStores: row.stores },
  }));
}

/** 随主体归档的原因必须与真实主体终局一致（02 第 2.10 节）。 */
export async function findI28Violations(db: Reader): Promise<InvariantViolation[]> {
  const rows = await db.$queryRaw<
    { id: string; entityId: string; reason: string; lifecycle: string }[]
  >`
    SELECT s.id::text, s.entity_id::text AS "entityId", s.archive_reason AS reason, e.lifecycle
      FROM store s JOIN entity e ON e.id = s.entity_id
     WHERE s.lifecycle = 'archived' AND (
       (s.archive_reason = 'entity_closed' AND e.lifecycle <> 'closed') OR
       (s.archive_reason = 'entity_abandoned' AND e.lifecycle <> 'abandoned'))
     ORDER BY s.id LIMIT ${TENANT_INVARIANT_LIMIT}`;
  return rows.map((row) => ({
    subject: { type: "store", id: row.id },
    entityId: row.entityId,
    detail: { archiveReason: row.reason, entityLifecycle: row.lifecycle },
  }));
}
