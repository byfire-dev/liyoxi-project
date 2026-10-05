// 乐观锁（W0-20）：内容编辑的版本关。依据：约定 第 7 节 C52、C53；06 第 3.3 节。
//
// 用法：用例的事务里先过版本关，再改内容。
//   const lockVersion = await bumpLockVersion(tx, { table: "point_pack", id, expected: input.lockVersion });
//   await tx.pointPack.update({ where: { id }, data: { priceFen, updatedAt: clock.now() } });
// 版本关是一条带版本条件的更新：版本相符则加 1 并拿住这一行（到事务结束），返回新版本；
// 不相符则回读最新值，抛 VERSION_CONFLICT，details 带最新值；行不存在抛 NOT_FOUND。
// 两个事务拿同一个版本来改，只有一个过得去：后到的等前一个提交，条件已不成立。
//
// 只管内容编辑。状态迁移用事务内行锁加状态守卫（flow.transition，W0-16），不走这里。
// 列名、主键列、details 里的字段名都可以指定，约定 C52 的几处例外因此都用得上：
//   delivery_plan 的第二把锁        column: "draft_lock_version"（字段名随之是 draftLockVersion）
//   许可行、剧集比对父剧目的版本    table: "drama"、id: 剧目 id、field: "dramaLockVersion"，过关之后再改子行
//   自然主键的表                    key: { column: "scene_key", type: "text" }
// 逐项修订号（param_value 的 expectedRev）比的是“每个键最新一行”，不是一行上的列，由领域自己写。
import { AppError } from "../errors.js";
import { isUuid } from "../ids.js";
import type { Tx } from "../tx.js";

export interface LockVersionTarget {
  /** 表名 */
  table: string;
  /** 主键的值 */
  id: string;
  /** 请求带来的版本：读详情时拿到的那个值 */
  expected: number;
  /** 锁版本列，缺省 lock_version */
  column?: string;
  /** 主键列，缺省 { column: "id", type: "uuid" } */
  key?: { column: string; type: "uuid" | "text" };
  /** VERSION_CONFLICT 的 details 里用的字段名（就是请求字段名）；缺省由列名转成小驼峰 */
  field?: string;
}

/** 库里的标识符：小写蛇形。表名、列名只从代码里的常量来，这里再挡一道，不让别的东西拼进 SQL */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const INT4_MAX = 2_147_483_647;

/** 锁版本列名 → 请求字段名：lock_version → lockVersion，draft_lock_version → draftLockVersion */
export const lockVersionField = (column: string): string =>
  column.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

/**
 * 过版本关：版本相符则加 1，返回新版本。之后在同一个事务里改内容（这一行已被本事务锁住）。
 * 写错了代码（标识符不合规、主键不是 UUID、版本不是非负整数）抛 TypeError：请求里的值先由路由的 Zod 结构把关。
 */
export async function bumpLockVersion(tx: Tx, target: LockVersionTarget): Promise<number> {
  const { table, id, expected, column = "lock_version" } = target;
  const key = target.key ?? { column: "id", type: "uuid" as const };
  const bad = [table, column, key.column].find((name) => !IDENTIFIER.test(name));
  if (bad !== undefined) throw new TypeError(`不是合规的表名或列名：${JSON.stringify(bad)}`);
  if (key.type === "uuid" && !isUuid(id)) {
    throw new TypeError(`主键要是 UUID，收到 ${JSON.stringify(id)}`);
  }
  if (!Number.isInteger(expected) || expected < 0 || expected > INT4_MAX) {
    throw new TypeError(`锁版本要是非负整数，收到 ${JSON.stringify(expected)}`);
  }
  const match = `"${key.column}" = $1::${key.type}`;
  const bumped = await tx.$queryRawUnsafe<Array<{ version: number }>>(
    `UPDATE "${table}" SET "${column}" = "${column}" + 1 WHERE ${match} AND "${column}" = $2::int RETURNING "${column}" AS version`,
    id,
    expected,
  );
  if (bumped[0]) return bumped[0].version;
  const latest = await tx.$queryRawUnsafe<Array<{ version: number }>>(
    `SELECT "${column}" AS version FROM "${table}" WHERE ${match}`,
    id,
  );
  if (!latest[0]) throw new AppError("NOT_FOUND");
  throw new AppError("VERSION_CONFLICT", {
    details: { [target.field ?? lockVersionField(column)]: latest[0].version },
  });
}
