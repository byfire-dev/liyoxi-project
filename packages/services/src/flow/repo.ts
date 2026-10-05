// flow 的仓储（W0-16）：本模块的原生 SQL 只写在这里。依据：01 分组 第 2.6 节；06 第 3.4、5 节。
// 表名、列名只来自登记值（契约的状态机清单、迁移表、状态机登记里的随迁列），不取用例传进来的字符串；
// 拼进语句之前仍过一遍 ident：不是小写蛇形的名字一律不拼。值全部走参数。
// 对象行的加锁不在这里：走 kernel 的 lockRows，锁序断言挂在它上面。
import type { Tx } from "../kernel/index.js";

/** 只读查询用得上的最小形状：事务句柄与 Prisma 客户端都合 */
export interface RawReader {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

function ident(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new TypeError(`不是合法的表名或列名：${name}`);
  return `"${name}"`;
}

/** 各表在库里有哪些列（当前 schema 下的普通表与分区表）；库里没有的表不在返回值里 */
export async function selectColumns(
  db: RawReader,
  tables: readonly string[],
): Promise<Map<string, Set<string>>> {
  const rows = await db.$queryRawUnsafe<Array<{ table: string; column: string }>>(
    `SELECT c.relname::text AS "table", a.attname::text AS "column"
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])`,
    [...tables],
  );
  const columns = new Map<string, Set<string>>();
  for (const row of rows) {
    const known = columns.get(row.table) ?? new Set<string>();
    columns.set(row.table, known.add(row.column));
  }
  return columns;
}

/** 对象行状态列的当前值。调用之前这一行已经锁住 */
export async function selectState(
  tx: Tx,
  machine: string,
  stateField: string,
  id: string,
): Promise<string | undefined> {
  const rows = await tx.$queryRawUnsafe<Array<{ state: string }>>(
    `SELECT ${ident(stateField)}::text AS state FROM ${ident(machine)} WHERE id = $1::uuid`,
    id,
  );
  return rows[0]?.state;
}

/** 随迁列的值变成 jsonb_populate_record 认的写法：时间给 ISO 串，bigint 给十进制串，二进制给 \x 十六进制 */
function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  return value ?? null;
}

export interface StateUpdate {
  readonly machine: string;
  readonly stateField: string;
  readonly id: string;
  readonly to: string;
  readonly now: Date;
  /** 表上有 lock_version：加 1 */
  readonly bumpVersion: boolean;
  /** 表上有 updated_at：赋业务时间 */
  readonly touch: boolean;
  /** 随迁列 → 值，与状态在同一条 UPDATE 里写（库的 CHECK 是逐语句查的，分两条写过不去） */
  readonly set: Readonly<Record<string, unknown>>;
}

/**
 * 改状态：一条 UPDATE。随迁列的值整体以一个 jsonb 参数传入，由 jsonb_populate_record 按该表的行类型转成各列的类型，
 * 不用逐列知道类型、逐列写类型转换。返回改到的行数。
 */
export function updateState(tx: Tx, update: StateUpdate): Promise<number> {
  const assignments = [`${ident(update.stateField)} = $2`];
  const values: unknown[] = [update.id, update.to];
  if (update.bumpVersion) assignments.push(`lock_version = t.lock_version + 1`);
  if (update.touch) {
    values.push(update.now.toISOString());
    assignments.push(`updated_at = $${values.length}::timestamptz`);
  }
  const companions = Object.keys(update.set);
  if (companions.length > 0) {
    values.push(
      JSON.stringify(
        Object.fromEntries(companions.map((column) => [column, jsonValue(update.set[column])])),
      ),
    );
    const list = companions.map(ident);
    assignments.push(
      `(${list.join(", ")}) = (SELECT ${list.map((column) => `p.${column}`).join(", ")}
         FROM jsonb_populate_record(null::${ident(update.machine)}, $${values.length}::jsonb) AS p)`,
    );
  }
  return tx.$executeRawUnsafe(
    `UPDATE ${ident(update.machine)} AS t SET ${assignments.join(", ")} WHERE t.id = $1::uuid`,
    ...values,
  );
}

export interface LastTransition {
  readonly occurredAt: Date;
  readonly toState: string;
}

/** 同一链 (machine, subject_id, state_field) 的上一行：按 seq 最大的那一行 */
export async function selectLastTransition(
  tx: Tx,
  machine: string,
  subjectId: string,
  stateField: string,
): Promise<LastTransition | undefined> {
  const rows = await tx.$queryRawUnsafe<LastTransition[]>(
    `SELECT occurred_at AS "occurredAt", to_state AS "toState" FROM status_transition
      WHERE machine = $1 AND subject_id = $2::uuid AND state_field = $3
      ORDER BY seq DESC LIMIT 1`,
    machine,
    subjectId,
    stateField,
  );
  return rows[0];
}

export interface TransitionRecord {
  readonly id: string;
  readonly machine: string;
  readonly subjectId: string;
  readonly stateField: string;
  readonly entityId: string | null;
  readonly storeId: string | null;
  readonly fromState: string | null;
  readonly toState: string;
  readonly event: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly client: string | null;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly occurredAt: Date;
  /** occurred_at 的北京时间日期，YYYY-MM-DD（库有 CHECK） */
  readonly bizDate: string;
  readonly elapsedSeconds: number | null;
  readonly elapsedWorkMin: number | null;
  readonly requestId: string | null;
}

/** 写一行状态历史。is_forced 恒为假（人工纠偏不走这里），on_behalf_of_user_id V1.0 不写；seq、created_at 由库给 */
export async function insertTransition(tx: Tx, row: TransitionRecord): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO status_transition (id, machine, subject_id, state_field, entity_id, store_id, from_state, to_state,
       event, actor_type, actor_id, client, reason_code, note, payload, is_forced, occurred_at, biz_date,
       elapsed_seconds, elapsed_work_min, request_id)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8,
       $9, $10, $11::uuid, $12, $13, $14, $15::jsonb, false, $16::timestamptz, $17::date,
       $18::int, $19::int, $20)`,
    row.id,
    row.machine,
    row.subjectId,
    row.stateField,
    row.entityId,
    row.storeId,
    row.fromState,
    row.toState,
    row.event,
    row.actorType,
    row.actorId,
    row.client,
    row.reasonCode,
    row.note,
    row.payload === null ? null : JSON.stringify(row.payload),
    row.occurredAt.toISOString(),
    row.bizDate,
    row.elapsedSeconds,
    row.elapsedWorkMin,
    row.requestId,
  );
}

export interface ChainBreak {
  /** broken_link：相邻两行首尾不相接；state_mismatch：最后一行的 to_state 不是表里的当前值 */
  readonly problem: "broken_link" | "state_mismatch";
  readonly subjectId: string;
  readonly entityId: string | null;
  /** 出问题的那一行状态历史 */
  readonly seq: bigint;
  readonly expected: string | null;
  readonly actual: string | null;
}

/** flow.I12 在一条链上的两项核对，按 seq 至多返回 limit 条。对象行已不存在的历史不比当前值 */
export function selectChainBreaks(
  db: RawReader,
  machine: string,
  stateField: string,
  limit: number,
): Promise<ChainBreak[]> {
  return db.$queryRawUnsafe<ChainBreak[]>(
    `WITH linked AS (
       SELECT subject_id, entity_id, seq, from_state, to_state,
              lag(to_state) OVER w AS prev_to_state,
              row_number() OVER w AS position,
              lead(seq) OVER w AS next_seq
         FROM status_transition
        WHERE machine = $1 AND state_field = $2
       WINDOW w AS (PARTITION BY subject_id ORDER BY seq)
     )
     SELECT 'broken_link' AS problem, l.subject_id::text AS "subjectId", l.entity_id::text AS "entityId", l.seq,
            l.prev_to_state AS expected, l.from_state AS actual
       FROM linked l
      WHERE l.position > 1 AND l.prev_to_state IS DISTINCT FROM l.from_state
     UNION ALL
     SELECT 'state_mismatch', l.subject_id::text, l.entity_id::text, l.seq, l.to_state, s.${ident(stateField)}::text
       FROM linked l JOIN ${ident(machine)} s ON s.id = l.subject_id
      WHERE l.next_seq IS NULL AND s.${ident(stateField)}::text IS DISTINCT FROM l.to_state
      ORDER BY seq LIMIT $3::int`,
    machine,
    stateField,
    limit,
  );
}
