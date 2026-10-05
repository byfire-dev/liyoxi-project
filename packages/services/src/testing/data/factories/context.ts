// 工厂共用的上下文与小工具（W0-25）。
import { createHash } from "node:crypto";

import type { Prisma } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import type { LocalDate } from "@liyoxi/shared/time";

import { uuidv7 } from "../../../kernel/index.js";
import type { Clock } from "../../../kernel/index.js";
import type { FactorySealer } from "../seal.js";

/** 工厂往哪插：Prisma 客户端，或 tx.run 给的事务句柄（句柄的类型上没有 $transaction，工厂也用不到它） */
export type FactoryDb = Omit<Prisma.TransactionClient, "$transaction">;

export interface FactoryContext {
  readonly db: FactoryDb;
  readonly seal: FactorySealer;
  /** 时间列都取它：注入的时钟的“现在” */
  now(): Date;
  /** 北京时间的今天 */
  today(): LocalDate;
  /** 主键：UUID v7 */
  id(): string;
  /** 进程内递增的序号：名字、手机号、单号的流水都从它来，同一个进程里不重复 */
  seq(): number;
}

// 序号放在模块上，不放在工厂实例上：同一个测试文件里建两套工厂、插同一个库，手机号与单号也不撞
let counter = 0;

export function createFactoryContext(deps: {
  db: FactoryDb;
  clock: Clock;
  seal: FactorySealer;
}): FactoryContext {
  return {
    db: deps.db,
    seal: deps.seal,
    now: () => deps.clock.now(),
    today: () => calendarDate(deps.clock.now()),
    id: uuidv7,
    seq: () => (counter += 1),
  };
}

/** 去掉值是 undefined 的键：覆盖的字段写了 undefined 等于没写，不能把缺省值冲掉 */
export function defined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

/** 假手机号：139 开头，后 8 位是序号 */
export const fakePhone = (n: number): string => `139${String(n).padStart(8, "0")}`;

/** 假的统一社会信用代码：18 位，后 6 位是序号（不保证校验位） */
export const fakeUscc = (n: number): string => `91310000MA1K${String(n).padStart(6, "0")}`;

/**
 * 假单号：格式同 kernel 的业务单号（前缀 + yyyyMMdd + 流水），流水从 90001 起。
 * 不动 biz_sequence：真实取号从 1 起，同一个库里两边撞不上。
 */
export const fakeBizNo = (prefix: string, today: LocalDate, n: number): string =>
  `${prefix}${today.replaceAll("-", "")}${90_000 + n}`;

/** DATE 列的值：Prisma 收 Date，取 UTC 零点的那一天 */
export const dateOnly = (date: LocalDate): Date => new Date(`${date}T00:00:00.000Z`);

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** 库里没有种子时给一句看得懂的话 */
export function seedMissing(what: string): Error {
  return new Error(
    `库里没有${what}：这个工厂要配带种子的库用（测试文件里写 useSeededDatabase，不是 useTestDatabase）`,
  );
}
