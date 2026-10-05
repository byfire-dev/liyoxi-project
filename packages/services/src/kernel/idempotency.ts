// 幂等（W0-13）：幂等上下文、同事务登记与重放、结果脱敏。
// 依据：约定 第 7 节 C47–C50；01 分组 第 2.1、4 节；D7 第 3.1 节。接进事务的那几行在 tx.ts 的 run 里。
//
//   1. 一条路由只有一种幂等方式。required：同事务先插幂等行（state = 'done'），再执行业务，提交前写回 result；
//      业务抛错则事务回滚、行不留，同一个键可以直接重试。natural、none：不读写幂等表。
//   2. 同键并发：后到者阻塞在主键上，前者提交后读到同一份结果；等锁超过 3 秒报 BUSY，不进 tx.run 的重试
//      （重试会把等待拉长到 3 秒的倍数）。
//   3. 重放不再执行业务：返回存下的结果，上下文的 replayed 为真。登记了脱敏路径的路由，
//      这些字段写入之前置为 null，重放的结果另带 replayed: true（约定 C50）。
//   4. 存的是用例函数的返回值（角色裁剪之前的 DTO），要能 JSON 序列化；密文、验证码这类不该留库的内容由用例函数保证不放。
//
// 本文件不引 tx.ts（tx.ts 要引这里，不能成环）：收事务句柄的两个函数把参数写成结构类型，只由 tx.run 调用。
// 要 Tx、KernelViolation 的几样（防漏用、过期清理、唯一冲突识别）在 idempotency-tools.ts。
// 三段式的 in_progress 占用、抢占、写回由 W0-20 加在这里；本包不产生 in_progress 行，读到即报 IDEMPOTENCY_IN_PROGRESS。
import type { XIdempotent } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";

import { actorKey } from "./actor.js";
import type { Actor } from "./actor.js";
import { AppError } from "./errors.js";
import { isIdempotencyKey, requestHash } from "./request-hash.js";
import type { RequestHashInput } from "./request-hash.js";

/** 同键并发时后到者最多等多久（约定 C50） */
export const IDEMPOTENCY_LOCK_WAIT_MS = 3_000;
/** 幂等行保留多久（约定 C49）。过期行由 ops.retention 每小时删 */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/** 脱敏路径：点分的字段名，数组逐项处理的那一段后面带 []，如 payParams、items[].posterUrl。最后一段不带 [] */
const REDACT_PATH = /^(?:[A-Za-z_][A-Za-z0-9_]*(?:\[\])?\.)*[A-Za-z_][A-Za-z0-9_]*$/;

export interface IdempotencyContextInput {
  /** 路由元数据 x-idempotent */
  mode: XIdempotent;
  /** 路由的 operationId */
  scope: string;
  /** 操作人：required 必给。下载页的请求给授权它的商家用户 */
  actor?: Actor | null;
  /** Idempotency-Key 请求头的原值；没带就不给 */
  key?: string | null;
  /** 算请求哈希的材料：方法、路径参数、请求体，商家端另给 storeId */
  request?: RequestHashInput;
  /** 路由元数据 x-redact-on-replay：写入幂等记录前要置空的字段路径 */
  redact?: readonly string[];
}

/** 幂等上下文：一次请求建一个，交给一次 tx.run。natural、none 也建，只为防漏用时不误报 */
export interface IdempotencyContext {
  readonly mode: XIdempotent;
  readonly scope: string;
  /** 下面三项只有 required 有值 */
  readonly actorKey: string | null;
  readonly key: string | null;
  readonly requestHash: string | null;
  readonly redact: readonly string[];
  /** 进过 tx.run 没有（防漏用看它） */
  readonly used: boolean;
  /** 这次是不是重放：tx.run 成功返回之后才有意义 */
  readonly replayed: boolean;
}

interface Marks {
  used: boolean;
  replayed: boolean;
}
const marksOf = new WeakMap<IdempotencyContext, Marks>();

function marks(ctx: IdempotencyContext): Marks {
  const found = marksOf.get(ctx);
  if (!found) throw new TypeError("这个幂等上下文不是 createIdempotencyContext 建的");
  return found;
}

/**
 * 建幂等上下文。required 缺键或键的格式不对：抛 IDEMPOTENCY_KEY_REQUIRED；别的不合法是写错了代码，抛 TypeError。
 */
export function createIdempotencyContext(input: IdempotencyContextInput): IdempotencyContext {
  const { mode, scope, actor = null, key = null, request, redact = [] } = input;
  if (scope === "") throw new TypeError("幂等上下文要给 scope（路由的 operationId）");
  const badPath = redact.find((path) => !REDACT_PATH.test(path));
  if (badPath !== undefined) throw new TypeError(`脱敏路径写法不对：${badPath}`);
  const required = mode === "required";
  if (required && !isIdempotencyKey(key)) throw new AppError("IDEMPOTENCY_KEY_REQUIRED");
  if (required && (actor === null || request === undefined)) {
    throw new TypeError("required 的幂等上下文要给操作人与算请求哈希的材料");
  }
  const state: Marks = { used: false, replayed: false };
  const ctx: IdempotencyContext = Object.freeze({
    mode,
    scope,
    actorKey: required && actor ? actorKey(actor) : null,
    key: required ? key : null,
    requestHash: required && request ? requestHash(request) : null,
    redact: Object.freeze([...redact]),
    get used() {
      return state.used;
    },
    get replayed() {
      return state.replayed;
    },
  });
  marksOf.set(ctx, state);
  return ctx;
}

/** tx.run 进门时调：记下“用过”。required 的上下文已经进过一次即返回 false（一个上下文只给一次 tx.run） */
export function enterIdempotency(ctx: IdempotencyContext): boolean {
  const state = marks(ctx);
  if (state.used && ctx.mode === "required") return false;
  state.used = true;
  return true;
}

/** tx.run 提交之后调：记下这次是不是重放 */
export function settleIdempotency(ctx: IdempotencyContext, replayed: boolean): void {
  marks(ctx).replayed = replayed;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function blank(node: unknown, segments: readonly string[]): void {
  const [head = "", ...rest] = segments;
  const each = head.endsWith("[]");
  const name = each ? head.slice(0, -2) : head;
  // 字段不在就不动：没有要藏的东西，也不凭空添一个键
  if (!isRecord(node) || !Object.hasOwn(node, name)) return;
  if (rest.length === 0) node[name] = null;
  else if (!each) blank(node[name], rest);
  else if (Array.isArray(node[name])) for (const item of node[name]) blank(item, rest);
}

/**
 * 结果脱敏：返回一份副本，paths 列出的字段置为 null；不改传进来的对象。
 * 副本经一次 JSON 往返，就是存进幂等记录、重放时读回来的样子。不能序列化（undefined、函数）即返回 undefined。
 */
export function redactForReplay(result: unknown, paths: readonly string[]): unknown {
  const text = JSON.stringify(result);
  if (text === undefined) return undefined;
  const copy: unknown = JSON.parse(text);
  for (const path of paths) blank(copy, path.split("."));
  return copy;
}

/** 事务句柄里用到的两个原生 SQL 入口。写成结构类型是为了不引 tx.ts；传进来的就是 tx.run 的句柄 */
type Sql = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

interface StoredRow {
  requestHash: string;
  state: string;
  result: string | null;
}

/**
 * 登记幂等行（只由 tx.run 调，ctx 是 required）。插进去了返回 undefined：接着执行业务。
 * 已有一条提交过的同键记录：哈希不同抛 IDEMPOTENCY_KEY_REUSED；done 返回存下的结果；in_progress 抛 IDEMPOTENCY_IN_PROGRESS。
 * 等锁只对这一句 INSERT 设 3 秒，之后恢复连接原来的 lock_timeout；等不到时数据库报 55P03，由 tx.run 转成 BUSY。
 */
export async function claimIdempotency(
  tx: Sql,
  ctx: IdempotencyContext,
): Promise<{ result: unknown } | undefined> {
  const { scope, actorKey: actor, key, requestHash: hash } = ctx;
  const wait = `${IDEMPOTENCY_LOCK_WAIT_MS}ms`;
  // 子查询先取旧值（OFFSET 0 不让它被拉平），外层再改：一句拿到前后两个值
  const [timeouts] = await tx.$queryRaw<{ before: string; after: string }[]>`
    SELECT p.before, set_config('lock_timeout', ${wait}, true) AS after
    FROM (SELECT current_setting('lock_timeout') AS before OFFSET 0) p`;
  // created_at、expires_at 用数据库时间（基础设施表，01 分组 第 2 节）：同一事务里 now() 不变，两者正好差 24 小时
  const inserted = await tx.$executeRaw`
    INSERT INTO idempotency_record (scope, actor_key, key, request_hash, state, expires_at)
    VALUES (${scope}, ${actor}, ${key}, ${hash}, 'done',
            now() + make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS}::int))
    ON CONFLICT (scope, actor_key, key) DO NOTHING`;
  if (timeouts && timeouts.before !== timeouts.after) {
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${timeouts.before}, true)`;
  }
  if (inserted === 1) return undefined;

  const [row] = await tx.$queryRaw<StoredRow[]>`
    SELECT request_hash AS "requestHash", state, result::text AS result
    FROM idempotency_record
    WHERE scope = ${scope} AND actor_key = ${actor} AND key = ${key}`;
  // 冲突的那一行刚好被过期清理删掉：极少见，让端上用同一个键再来一次
  if (!row) throw new AppError("BUSY");
  if (row.requestHash !== hash) throw new AppError("IDEMPOTENCY_KEY_REUSED");
  if (row.state !== "done") throw new AppError("IDEMPOTENCY_IN_PROGRESS");
  // result 为空：用例函数没有返回值
  const result: unknown = row.result === null ? undefined : JSON.parse(row.result);
  const marked = ctx.redact.length > 0 && isRecord(result);
  return { result: marked ? { ...result, replayed: true } : result };
}

/** 提交前写回结果（只由 tx.run 调）。用例函数没有返回值就不写，result 留空 */
export async function storeIdempotentResult(
  tx: Sql,
  ctx: IdempotencyContext,
  result: unknown,
): Promise<void> {
  const text = JSON.stringify(ctx.redact.length > 0 ? redactForReplay(result, ctx.redact) : result);
  if (text === undefined) return;
  await tx.$executeRaw`
    UPDATE idempotency_record SET result = ${text}::jsonb, updated_at = now()
    WHERE scope = ${ctx.scope} AND actor_key = ${ctx.actorKey} AND key = ${ctx.key}`;
}

// ---------- 三段式的占用、抢占、写回、释放（W0-20） ----------
// 只由 three-phase/ 的工具在它自己开的事务里调，ctx 是 required。依据：约定 C51；01 分组 第 2.1 节的状态机；D7 第 3.1 节。
// locked_until 取注入的应用时钟（任务书 第 10 节第 4 项），由调用方算好传进来；它同时是这次占用的凭据：
// 写回、释放都带着它，占用过期后被别的请求接手了，原来那一方就改不动这一行。

/** 三段式占用多久（约定 C51）。常量，不做成参数 */
export const IDEMPOTENCY_LEASE_MS = 30_000;

/** 占用的结果：occupied 这次插进去了；done 早已完成，带存下的结果；in_progress 别的请求占着，带它的到期时间 */
export type IdempotencyOccupation =
  | { state: "occupied" }
  | { state: "done"; result: unknown }
  | { state: "in_progress"; lockedUntil: Date };

/** 读同键的那一行。哈希不同抛 IDEMPOTENCY_KEY_REUSED；行不在返回 undefined */
async function readOccupation(
  tx: Sql,
  ctx: IdempotencyContext,
): Promise<Exclude<IdempotencyOccupation, { state: "occupied" }> | undefined> {
  const [row] = await tx.$queryRaw<(StoredRow & { lockedUntil: Date | null })[]>`
    SELECT request_hash AS "requestHash", state, result::text AS result, locked_until AS "lockedUntil"
    FROM idempotency_record
    WHERE scope = ${ctx.scope} AND actor_key = ${ctx.actorKey} AND key = ${ctx.key}`;
  if (!row) return undefined;
  if (row.requestHash !== ctx.requestHash) throw new AppError("IDEMPOTENCY_KEY_REUSED");
  if (row.state !== "done") {
    return { state: "in_progress", lockedUntil: row.lockedUntil ?? new Date(0) };
  }
  // 与 claimIdempotency 的重放同一个写法：登记了脱敏路径的路由，重放的结果另带 replayed: true
  const result: unknown = row.result === null ? undefined : JSON.parse(row.result);
  const marked = ctx.redact.length > 0 && isRecord(result);
  return { state: "done", result: marked ? { ...result, replayed: true } : result };
}

/**
 * 占用（三段式第 ① 步）：插一条 in_progress 行，随这个事务连同业务意图一起提交。
 * 已有同键记录时不改它，照实返回：哈希不同抛 IDEMPOTENCY_KEY_REUSED；过期没有、抢不抢由调用方定。
 * 同键的另一个占用还没提交时，这一句会等它（受连接自己的 lock_timeout 管）。
 */
export async function occupyIdempotency(
  tx: Sql,
  ctx: IdempotencyContext,
  lockedUntil: Date,
): Promise<IdempotencyOccupation> {
  const inserted = await tx.$executeRaw`
    INSERT INTO idempotency_record (scope, actor_key, key, request_hash, state, locked_until, expires_at)
    VALUES (${ctx.scope}, ${ctx.actorKey}, ${ctx.key}, ${ctx.requestHash}, 'in_progress',
            ${lockedUntil}::timestamptz,
            now() + make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS}::int))
    ON CONFLICT (scope, actor_key, key) DO NOTHING`;
  if (inserted === 1) return { state: "occupied" };
  const found = await readOccupation(tx, ctx);
  // 冲突的那一行刚好被删掉（过期清理，或对方失败后释放）：让端上用同一个键再来一次
  if (!found) throw new AppError("BUSY");
  return found;
}

/**
 * 抢占：占用已过期（locked_until <= now）才改得动，改成新的到期时间。条件更新：
 * 同时到的几个请求里只有一个改到，其余的等它提交后发现条件不再成立，返回 false。
 */
export async function takeOverIdempotency(
  tx: Sql,
  ctx: IdempotencyContext,
  now: Date,
  lockedUntil: Date,
): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE idempotency_record SET locked_until = ${lockedUntil}::timestamptz, updated_at = now()
    WHERE scope = ${ctx.scope} AND actor_key = ${ctx.actorKey} AND key = ${ctx.key}
      AND state = 'in_progress' AND locked_until <= ${now}::timestamptz`;
  return updated === 1;
}

/**
 * 写回（三段式第 ③ 步，末个事务里最先调）：把自己的占用改成 done，拿住这一行；之后写业务结果，
 * 提交前用 storeIdempotentResult 存结果。改到了返回 undefined。
 * 没改到，说明占用过期后被别的请求接手了：它已经写完，返回它存下的结果（业务结果不再写）；
 * 它还占着，抛 IDEMPOTENCY_IN_PROGRESS；行不在了（它失败后释放了），抛 BUSY。
 */
export async function completeIdempotency(
  tx: Sql,
  ctx: IdempotencyContext,
  lockedUntil: Date,
): Promise<{ result: unknown } | undefined> {
  const updated = await tx.$executeRaw`
    UPDATE idempotency_record SET state = 'done', locked_until = NULL, updated_at = now()
    WHERE scope = ${ctx.scope} AND actor_key = ${ctx.actorKey} AND key = ${ctx.key}
      AND state = 'in_progress' AND locked_until = ${lockedUntil}::timestamptz`;
  if (updated === 1) return undefined;
  const found = await readOccupation(tx, ctx);
  if (!found) throw new AppError("BUSY");
  if (found.state !== "done") throw new AppError("IDEMPOTENCY_IN_PROGRESS");
  return { result: found.result };
}

/**
 * 释放：业务失败时删掉自己的占用（只持久化成功：同一个键可以直接重试）。
 * 返回删了没有；false 表示占用已经不是自己的，补偿留给接手的那一方。
 */
export async function releaseIdempotency(
  tx: Sql,
  ctx: IdempotencyContext,
  lockedUntil: Date,
): Promise<boolean> {
  const deleted = await tx.$executeRaw`
    DELETE FROM idempotency_record
    WHERE scope = ${ctx.scope} AND actor_key = ${ctx.actorKey} AND key = ${ctx.key}
      AND state = 'in_progress' AND locked_until = ${lockedUntil}::timestamptz`;
  return deleted === 1;
}
