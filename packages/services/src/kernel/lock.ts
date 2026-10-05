// 加锁函数（W0-07）：SELECT … FOR UPDATE、FOR SHARE，锁序断言挂在它上面（06 第 5 节；ADR-012）。
// 多行加锁只走这里：表限定在加锁顺序表之内，同一张表的多行按主键升序。
//
// 锁的强度记在这里，不在锁序断言里：已持有的行再锁一遍不算违规，但把共享锁升级成排他锁是一次新的等锁，
// 两个事务都先共享后升级会互相等死。所以升级按“这几行还没锁过”再查一遍次序：之后没锁过次序更大的表、
// 同一张表里没锁过主键更大的行，才放行。
import { isUuid } from "./ids.js";
import { assertLockOrder, checkLockOrder, LOCK_ORDER } from "./lock-order.js";
import type { LockTable } from "./lock-order.js";
import { KernelViolation, txState } from "./tx.js";
import type { HeldLock, Tx } from "./tx.js";

/** 主键列不叫 id 的表 */
const KEY_COLUMN: Partial<Record<LockTable, string>> = {
  store_profile: "store_id",
  production_record: "file_id",
  billing_account: "entity_id",
};

/** lockRows 管的表：主键是单列 uuid。assignment_cursor 是复合主键，取号的地方自己写 SQL，先调 assertLockOrder */
export type RowLockTable = Exclude<LockTable, "assignment_cursor">;

/** update：FOR UPDATE，要改这一行；share：FOR SHARE，只读它的状态做判断、不许别人同时改 */
export type RowLockMode = "update" | "share";

/** 这一行现在持有的是不是只有共享锁：有记录，且每一条记的都是 share */
const sharedOnly = (held: readonly HeldLock[], table: string, key: string): boolean => {
  const mine = held.filter((lock) => lock.table === table && lock.key === key);
  return mine.length > 0 && mine.every((lock) => lock.mode === "share");
};

/**
 * 锁住一张表的若干行，返回实际锁到的主键，升序。不存在的行不在返回值里，缺了哪一行由调用方判断。
 * 传进来的顺序不论，这里按主键升序排好再发；主键是 UUID，字符串的序与库里 uuid 的序一致。
 * 已持有的行再锁一遍不算违规；把共享锁升级成排他锁按新加的锁再查一遍次序（见文件头）。
 */
export async function lockRows(
  tx: Tx,
  table: RowLockTable,
  ids: readonly string[],
  mode: RowLockMode = "update",
): Promise<string[]> {
  // 表名、强度要拼进 SQL。类型已经限定了取值，运行时再核对一遍：强转进来的不能放过去
  if (!Object.hasOwn(LOCK_ORDER, table) || (table as LockTable) === "assignment_cursor") {
    throw new TypeError(
      `lockRows 只锁加锁顺序表里、主键是单列 uuid 的表，收到 ${JSON.stringify(table)}`,
    );
  }
  if (mode !== "update" && mode !== "share") {
    throw new TypeError(`lockRows 的强度只有 update、share，收到 ${JSON.stringify(mode)}`);
  }
  const keys = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  const bad = keys.find((key) => !isUuid(key));
  if (bad !== undefined) throw new TypeError(`lockRows 只接受 UUID，收到 ${JSON.stringify(bad)}`);
  if (keys.length === 0) return [];
  const state = txState(tx);
  const upgrades =
    mode === "update" ? keys.filter((key) => sharedOnly(state.held, table, key)) : [];
  if (upgrades.length > 0) {
    const others = state.held.filter(
      (lock) => !(lock.table === table && upgrades.includes(lock.key)),
    );
    const problem = checkLockOrder(others, table, upgrades);
    if (problem !== undefined) {
      state.violate(
        new KernelViolation("lock_order", `把共享锁升级成排他锁算一次新的加锁。${problem}`),
      );
    }
  }
  const before = state.held.length;
  assertLockOrder(tx, table, keys);
  for (const lock of state.held.slice(before)) lock.mode = mode;
  // 升级另记一条，不改原来那条：保存点回滚时记录按长度截回去，升级的这一条跟着退，强度回到共享
  for (const key of upgrades) state.held.push({ table, key, mode });
  const column = KEY_COLUMN[table] ?? "id";
  const strength = mode === "share" ? "SHARE" : "UPDATE";
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "${column}"::text AS id FROM "${table}" WHERE "${column}" = ANY($1::uuid[]) ORDER BY "${column}" FOR ${strength}`,
    keys,
  );
  return rows.map((row) => row.id);
}
