// flow 连库用例的共用部分（W0-16）：只给本目录的测试用。
// 用真实的状态机表（staff、entity、approval_request），父行在这里按最少字段自建；不建测试专用表。
// 连接是支架给的缺省身份（应用角色 lyx_app）。
import { randomBytes } from "node:crypto";

import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";

import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { SAMPLE_FLOW_EVENT } from "../../testing/index.js";
import type { TestDatabase } from "../../testing/index.js";
import type { AuditEntry } from "../../audit/index.js";

/** 连库的用例与钩子的时限：机器忙的时候建库、删库都慢 */
export const SLOW = 120_000;

type Db = PrismaClient | Tx;

const STAMP = "2026-01-05T04:00:00.000Z";

/** 员工角色：staff 的外键要它。重复调用不报错 */
export async function seedStaffRole(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO staff_role (key, name, description, module_levels, actions, data_scope, available_from, created_at, updated_at)
     VALUES ('cs', '客服', '样例角色', '{}'::jsonb, '{}'::jsonb, 'all', 'v1.0', $1::timestamptz, $1::timestamptz)
     ON CONFLICT (key) DO NOTHING`,
    STAMP,
  );
}

/** 插入一名员工，返回 id。status 是初始状态（新建由用例插入业务行，再调 transition） */
export async function insertStaff(
  db: Db,
  status: "active" | "pending" = "active",
): Promise<string> {
  const id = uuidv7();
  await db.$executeRawUnsafe(
    `INSERT INTO staff (id, name, phone_enc, phone_bidx, phone_mask, phone_last4, staff_role_key, status, created_at, updated_at)
     VALUES ($1::uuid, '样例员工', 'enc', $2, '138****0000', '0000', 'cs', $3, $4::timestamptz, $4::timestamptz)`,
    id,
    randomBytes(32),
    status,
    STAMP,
  );
  return id;
}

/** 插入一个主体（连同它的创建人），返回 id。认证要的几列先填好，库的 CHECK 只在 verified 时要求它们非空 */
export async function insertEntity(db: Db): Promise<string> {
  const userId = uuidv7();
  const id = uuidv7();
  await db.$executeRawUnsafe(
    `INSERT INTO merchant_user (id, status, source_type, phone_enc, phone_bidx, phone_mask, phone_last4, last_active_at, created_at, updated_at)
     VALUES ($1::uuid, 'active', 'organic', 'enc', $2, '138****0000', '0000', $3::timestamptz, $3::timestamptz, $3::timestamptz)`,
    userId,
    randomBytes(32),
    STAMP,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO entity (id, lifecycle, verification_status, source_type, created_by_user_id, name, entity_type,
       uscc_enc, uscc_bidx, uscc_mask, created_at, updated_at)
     VALUES ($1::uuid, 'active', 'unsubmitted', 'organic', $2::uuid, '样例主体', 'enterprise',
       'enc', $3, '9151****0000', $4::timestamptz, $4::timestamptz)`,
    id,
    userId,
    randomBytes(32),
    STAMP,
  );
  return id;
}

/** 插入一张待决的审批单（财务配置变更：不带主体与门店），返回审批单 id 与发起员工的 id */
export async function insertApproval(db: Db): Promise<{ id: string; staffId: string }> {
  const staffId = await insertStaff(db);
  const id = uuidv7();
  await db.$executeRawUnsafe(
    `INSERT INTO approval_request (id, kind, category, subject_type, subject_id, status, summary_snapshot,
       submit_actor_type, submit_actor_id, submit_client, requester_staff_id, dedupe_key, submitted_at, created_at, updated_at)
     VALUES ($1::uuid, 'finance_config_change', 'approval', 'finance_config_revision', $2::uuid, 'pending',
       '{"title":"样例审批"}'::jsonb, 'staff', $3::uuid, 'admin', $3::uuid, 'lyxtest:' || $1, $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
    id,
    uuidv7(),
    staffId,
    STAMP,
  );
  return { id, staffId };
}

/** 在一个主体下插入一家门店（lifecycle = active），返回 id */
export async function insertStore(db: Db, entityId: string): Promise<string> {
  const id = uuidv7();
  await db.$executeRawUnsafe(
    `INSERT INTO store (id, entity_id, lifecycle, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'active', $3::timestamptz, $3::timestamptz)`,
    id,
    entityId,
    STAMP,
  );
  return id;
}

/** 进入某个状态时要随状态一起写的列：库的 CHECK 把它们与状态绑在一起。column 是“表.列” */
export function companionsFor(column: string, to: string, now: Date): Record<string, unknown> {
  switch (column) {
    case "staff.status":
      return to === "disabled"
        ? { disabled_at: now, disabled_reason: "other" }
        : { disabled_at: null, disabled_reason: null };
    case "entity.lifecycle":
      return { closed_at: to === "active" ? null : now };
    case "entity.verification_status":
      return { verified_at: to === "verified" ? now : null };
    default:
      return {};
  }
}

/** 绕过 flow 把对象摆到某个状态：只给用例摆初始局面与“有人绕过 transition”的反例用 */
export async function place(
  db: Db,
  chain: { machine: string; stateField: string; column: string },
  id: string,
  state: string,
  now: Date,
): Promise<void> {
  const set: Record<string, unknown> = {
    [chain.stateField]: state,
    ...companionsFor(chain.column, state, now),
  };
  const columns = Object.keys(set);
  await db.$executeRawUnsafe(
    `UPDATE "${chain.machine}" SET ${columns
      .map(
        (column, index) =>
          `"${column}" = $${index + 2}${column.endsWith("_at") ? "::timestamptz" : ""}`,
      )
      .join(", ")} WHERE id = $1::uuid`,
    id,
    ...columns.map((column) =>
      set[column] instanceof Date ? set[column].toISOString() : set[column],
    ),
  );
}

/** 另开一个连到本文件测试库的客户端：一个客户端就是一条独立的连接。用完自己 $disconnect() */
export async function openClient(db: TestDatabase): Promise<PrismaClient> {
  return createPrismaClient({ connectionString: await db.url(), max: 1 });
}

/** 栅栏：n 方都到了才一起放行 */
export function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return () => {
    arrived += 1;
    if (arrived >= n) open();
    return opened;
  };
}

/** 后台员工的身份上下文 */
export const staffContext = (staffId: string = uuidv7()) =>
  createIdentityContext({
    actor: { type: "staff", id: staffId, client: "admin" },
    requestId: "req-flow-0001",
  });

/** 随迁移发的样例事件 */
export const changed = { type: SAMPLE_FLOW_EVENT, payload: { v: 1 } } as const;

/** 用例传入的 ops 审计（员工的新增、启用、禁用都要传） */
export const opsAudit = (staffId: string, summary = "样例：改员工状态"): AuditEntry => ({
  stream: "ops",
  category: "staff_authz",
  action: "lyxtest.staff.transition",
  summary,
  target: { type: "staff", id: staffId },
});

export interface HistoryRow {
  readonly id: string;
  readonly stateField: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly event: string;
  readonly bizDate: string;
  readonly elapsedSeconds: number | null;
  readonly elapsedWorkMin: number | null;
  readonly isForced: boolean;
  readonly actorType: string;
  readonly requestId: string | null;
}

/** 一个对象的状态历史，按 seq；可只取一个状态列 */
export function historyOf(db: Db, subjectId: string, stateField?: string): Promise<HistoryRow[]> {
  return db.$queryRawUnsafe<HistoryRow[]>(
    `SELECT id::text AS id, state_field AS "stateField", from_state AS "fromState", to_state AS "toState", event,
            biz_date::text AS "bizDate", elapsed_seconds AS "elapsedSeconds", elapsed_work_min AS "elapsedWorkMin",
            is_forced AS "isForced", actor_type AS "actorType", request_id AS "requestId"
       FROM status_transition
      WHERE subject_id = $1::uuid AND ($2::text IS NULL OR state_field = $2)
      ORDER BY seq`,
    subjectId,
    stateField ?? null,
  );
}

/** 四处的行数：状态历史、审计、出站事件各有几行（全库） */
export async function tally(
  db: PrismaClient,
): Promise<{ history: number; audit: number; events: number }> {
  const [history, audit, events] = await Promise.all([
    db.statusTransition.count(),
    db.auditLog.count(),
    db.outboxEvent.count(),
  ]);
  return { history, audit, events };
}

/** 对象行某个状态列的当前值 */
export async function stateOf(db: Db, table: string, column: string, id: string): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ state: string }>>(
    `SELECT "${column}"::text AS state FROM "${table}" WHERE id = $1::uuid`,
    id,
  );
  return (rows[0] as { state: string }).state;
}
