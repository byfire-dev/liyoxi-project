// 表快照比较器（W0-25；D7 第 10.1 节）：把若干张表的内容规整成可比较的结构，比两个时刻的行，报增、删、改。
// 幂等与回放测试用（D7 第 10.2 节 P5：同一个幂等键调 k 次，终态与调一次的表快照相同）。
//
//   const before = await snapshotTables(prisma, ["drama_order", "order_item", "point_hold"]);
//   await 用例();
//   const after = await snapshotTables(prisma, ["drama_order", "order_item", "point_hold"]);
//   const diff = diffSnapshots(before, after, { ignore: ["updated_at", "lock_version"] });
//   expect(diff.equal, formatSnapshotDiff(diff)).toBe(true);     // 或 assertSnapshotsEqual(before, after, …)
//
// 规整：每行读成 to_jsonb(行)——时间是带时区的 ISO 文本（按会话时区写），bytea 是 \x 开头的十六进制，数组是数组，jsonb 原样；
// 行按键排好序。所以两张快照可以直接 toEqual；要知道差在哪、要忽略列，用 diffSnapshots。
// 认行：缺省按主键。回放测试里主键每次不同（UUID v7）时，用 keyBy 换成业务上的唯一键，再把主键列忽略掉。
// 只读，可以传 Prisma 客户端或事务句柄。整张表读进内存：给测试用，不要拿去读大表。
import type { SqlReader } from "../../kernel/index.js";

/** 一行：列名（库里的写法，snake_case）→ 规整后的值 */
export type SnapshotRow = Readonly<Record<string, unknown>>;

export interface TableSnapshot {
  readonly table: string;
  /** 认行用的列：主键，或 keyBy 指定的 */
  readonly keyColumns: readonly string[];
  /** 全部行，按键排序 */
  readonly rows: readonly SnapshotRow[];
}

/** 若干张表在某一刻的内容：表名 → 快照，表名按字母序 */
export type TablesSnapshot = Readonly<Record<string, TableSnapshot>>;

export interface SnapshotOptions {
  /** 认行用的列，按表给；没给的表取主键 */
  readonly keyBy?: Readonly<Record<string, readonly string[]>>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`${what}只收小写字母、数字、下划线：${JSON.stringify(name)}`);
  }
}

/** 键列的值拼成一个可比较的文本 */
const keyOf = (row: SnapshotRow, keyColumns: readonly string[]): string =>
  JSON.stringify(keyColumns.map((column) => row[column] ?? null));

/** 记下这些表此刻的全部行。表不存在、没有主键又没给 keyBy、键不唯一，都抛错 */
export async function snapshotTables(
  db: SqlReader,
  tables: readonly string[],
  options: SnapshotOptions = {},
): Promise<TablesSnapshot> {
  const names = [...new Set(tables)].sort();
  for (const name of names) assertIdentifier(name, "表名");
  const primaryKeys = await db.$queryRawUnsafe<{ table_name: string; columns: string[] | null }[]>(
    `SELECT c.relname AS table_name,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
              WHERE i.indrelid = c.oid AND i.indisprimary) AS columns
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    JSON.stringify(names),
  );
  const known = new Map(primaryKeys.map((row) => [row.table_name, row.columns ?? []]));

  const snapshot: Record<string, TableSnapshot> = {};
  for (const table of names) {
    const primaryKey = known.get(table);
    if (primaryKey === undefined) throw new Error(`库里没有这张表：${table}`);
    const keyColumns = options.keyBy?.[table] ?? primaryKey;
    if (keyColumns.length === 0) {
      throw new Error(`${table} 没有主键：用 keyBy 指定认行的列`);
    }
    for (const column of keyColumns) assertIdentifier(column, "列名");
    const found = await db.$queryRawUnsafe<{ row: SnapshotRow }[]>(
      `SELECT to_jsonb(t) AS row FROM "${table}" t`,
    );
    const sample = found[0]?.row;
    const unknown = keyColumns.find((column) => sample !== undefined && !(column in sample));
    if (unknown !== undefined) throw new Error(`${table} 没有 ${unknown} 这一列`);
    const keyed = found
      .map(({ row }) => ({ key: keyOf(row, keyColumns), row }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const repeated = keyed.find((item, index) => index > 0 && keyed[index - 1]?.key === item.key);
    if (repeated !== undefined) {
      throw new Error(`${table} 按 ${keyColumns.join("、")} 认行不唯一：${repeated.key}`);
    }
    snapshot[table] = { table, keyColumns, rows: keyed.map((item) => item.row) };
  }
  return snapshot;
}

/** 忽略的列：一个清单（对所有表生效），或按表给（键 "*" 对所有表生效） */
export type IgnoreColumns = readonly string[] | Readonly<Record<string, readonly string[]>>;

export interface DiffOptions {
  /** 这些列变了不算改；增、删的行照报 */
  readonly ignore?: IgnoreColumns;
}

export interface RowChange {
  /** 这一行的键：键列 → 值 */
  readonly key: SnapshotRow;
  /** 变了的列（不含忽略的），按列名排序 */
  readonly columns: readonly string[];
  readonly before: SnapshotRow;
  readonly after: SnapshotRow;
}

export interface TableDiff {
  readonly table: string;
  readonly added: readonly SnapshotRow[];
  readonly removed: readonly SnapshotRow[];
  readonly changed: readonly RowChange[];
}

export interface SnapshotDiff {
  /** 没有增、删、改 */
  readonly equal: boolean;
  /** 有差异的表，按表名排序；没差异的表不在里面 */
  readonly tables: readonly TableDiff[];
}

/** 对象的键排好序再转文本：比较 jsonb 的值时不受键的先后影响 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}

function ignoredFor(ignore: IgnoreColumns | undefined, table: string): ReadonlySet<string> {
  if (ignore === undefined) return new Set();
  if (Array.isArray(ignore)) return new Set(ignore as readonly string[]);
  const byTable = ignore as Readonly<Record<string, readonly string[]>>;
  return new Set([...(byTable["*"] ?? []), ...(byTable[table] ?? [])]);
}

/** 比两张快照：按键认行，报增、删、改。两边的表、各表认行的列必须相同，否则抛错 */
export function diffSnapshots(
  before: TablesSnapshot,
  after: TablesSnapshot,
  options: DiffOptions = {},
): SnapshotDiff {
  const names = Object.keys(before).sort();
  if (stable(names) !== stable(Object.keys(after).sort())) {
    throw new Error(
      `两张快照的表不一样：前 ${names.join("、")}；后 ${Object.keys(after).sort().join("、")}`,
    );
  }
  const tables: TableDiff[] = [];
  for (const table of names) {
    const [old, now] = [before[table], after[table]];
    if (old === undefined || now === undefined) continue;
    if (stable(old.keyColumns) !== stable(now.keyColumns)) {
      throw new Error(`${table} 在两张快照里认行的列不一样`);
    }
    const ignored = ignoredFor(options.ignore, table);
    const keyColumns = old.keyColumns;
    const pick = (row: SnapshotRow): SnapshotRow =>
      Object.fromEntries(keyColumns.map((column) => [column, row[column] ?? null]));
    const oldRows = new Map(old.rows.map((row) => [keyOf(row, keyColumns), row]));
    const nowRows = new Map(now.rows.map((row) => [keyOf(row, keyColumns), row]));

    const removed = old.rows.filter((row) => !nowRows.has(keyOf(row, keyColumns)));
    const added = now.rows.filter((row) => !oldRows.has(keyOf(row, keyColumns)));
    const changed: RowChange[] = [];
    for (const [key, row] of oldRows) {
      const next = nowRows.get(key);
      if (next === undefined) continue;
      const columns = [...new Set([...Object.keys(row), ...Object.keys(next)])]
        .filter((column) => !ignored.has(column) && stable(row[column]) !== stable(next[column]))
        .sort();
      if (columns.length > 0) changed.push({ key: pick(row), columns, before: row, after: next });
    }
    if (added.length + removed.length + changed.length > 0) {
      tables.push({ table, added, removed, changed });
    }
  }
  return { equal: tables.length === 0, tables };
}

/** 把差异写成几行给人看的字：断言失败时当说明用 */
export function formatSnapshotDiff(diff: SnapshotDiff): string {
  if (diff.equal) return "没有差异";
  const lines: string[] = [];
  for (const { table, added, removed, changed } of diff.tables) {
    lines.push(`${table}：增 ${added.length} 行，删 ${removed.length} 行，改 ${changed.length} 行`);
    for (const row of added) lines.push(`  增 ${stable(row)}`);
    for (const row of removed) lines.push(`  删 ${stable(row)}`);
    for (const change of changed) {
      const parts = change.columns.map(
        (column) => `${column} ${stable(change.before[column])} → ${stable(change.after[column])}`,
      );
      lines.push(`  改 ${stable(change.key)}：${parts.join("；")}`);
    }
  }
  return lines.join("\n");
}

/** 两张快照有差异即抛错，说明里写着差在哪 */
export function assertSnapshotsEqual(
  before: TablesSnapshot,
  after: TablesSnapshot,
  options: DiffOptions = {},
): void {
  const diff = diffSnapshots(before, after, options);
  if (!diff.equal) throw new Error(`表快照不一致：\n${formatSnapshotDiff(diff)}`);
}
