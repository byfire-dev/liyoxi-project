// 种子与 SQL 断言的共用形态（W0-21）。各模块在自己的 seed.ts 里用 defineSeed 写一份，从模块入口给出；
// 包级的 seed.ts 按固定顺序跑。规矩只有一条：没有才插，已有的行一概不改——运营改过的配置要留着，
// 所以种子可以每次发版紧跟迁移再跑一遍，注册表里新登记的键自动补进库。
// 播种没有操作人：不写审计、不发事件，操作人列留空；时间取运行器从注入的时钟拿到的那一刻。
import type { Tx } from "./tx.js";

export interface SeedContext {
  /** 本次播种的时刻：一次运行里各表的时间列都写它 */
  readonly now: Date;
}

/** 一张表这一趟的结果 */
export interface SeedTableResult {
  readonly table: string;
  /** 这一趟新插的行数 */
  readonly inserted: number;
  /** 种子里有、库里已经有的行数（没有动它们） */
  readonly existing: number;
}

export interface ModuleSeed {
  /** 模块目录名 */
  readonly module: string;
  readonly run: (tx: Tx, context: SeedContext) => Promise<readonly SeedTableResult[]>;
}

export function defineSeed(module: string, run: ModuleSeed["run"]): ModuleSeed {
  return { module, run };
}

export interface InsertMissingOptions<Row> {
  readonly table: string;
  readonly rows: readonly Row[];
  /** 这一行按什么认“库里已经有了”：自然键，或业务上的唯一键 */
  readonly keyOf: (row: Row) => string;
  /** 库里已有的键（同一种写法） */
  readonly existingKeys: () => Promise<readonly string[]>;
  /** 把缺的行插进去 */
  readonly insert: (missing: readonly Row[]) => Promise<unknown>;
}

/** 没有才插：库里已有的键跳过，只插缺的。种子里的键自己重复即抛错 */
export async function insertMissing<Row>(
  options: InsertMissingOptions<Row>,
): Promise<SeedTableResult> {
  const keys = options.rows.map(options.keyOf);
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) {
    throw new Error(`种子数据里 ${options.table} 的键重复：${repeated}`);
  }
  const existing = new Set(await options.existingKeys());
  const missing = options.rows.filter((row) => !existing.has(options.keyOf(row)));
  if (missing.length > 0) await options.insert(missing);
  return {
    table: options.table,
    inserted: missing.length,
    existing: options.rows.length - missing.length,
  };
}

/** 能跑只读 SQL 的东西：Prisma 客户端或事务句柄 */
export interface SqlReader {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * 一条写成 SQL 的不变量断言：查询返回违规行，0 行即通过。
 * 每行两列：subject_key（违规对象的键）、detail（一句话说明）。
 * 要对照代码里登记表的，把清单作参数传入：参数一律是 JSON 文本，SQL 里写 $1::jsonb 展开。
 */
export interface SqlAssertion {
  /** 不变量编码，如 config.N9 */
  readonly code: string;
  readonly title: string;
  readonly sql: string;
  readonly params: readonly string[];
}

export interface AssertionViolation {
  readonly code: string;
  readonly subjectKey: string;
  readonly detail: string;
}

export async function runSqlAssertion(
  db: SqlReader,
  assertion: SqlAssertion,
): Promise<AssertionViolation[]> {
  const rows = await db.$queryRawUnsafe<{ subject_key: string; detail: string }[]>(
    assertion.sql,
    ...assertion.params,
  );
  return rows.map((row) => ({
    code: assertion.code,
    subjectKey: String(row.subject_key),
    detail: String(row.detail),
  }));
}
