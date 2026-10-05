// 账本内核的共用类型与内部错误（W1-10）。
import type { EnumValue, POINT_BUCKET, POINT_LOT_KIND } from "@liyoxi/contract/enums";
import type { PrismaClient } from "@liyoxi/db";

import type { Events } from "../../events/index.js";
import type { Clock, Tx } from "../../kernel/index.js";

/** 只读用：Prisma 客户端或事务句柄。读函数不拿账户锁、不 advance */
export type Db = PrismaClient | Tx;

export type Bucket = EnumValue<typeof POINT_BUCKET>;
export type LotKind = EnumValue<typeof POINT_LOT_KIND>;

/** 账本每写完一步报一次的步骤名（07 分组 第 2.15 节“写入顺序”，另加周期与事件几步）。故障注入的用例按它下断点 */
export const LEDGER_STEPS = [
  "lot.insert",
  "schedule.grant",
  "operation.insert",
  "lot.update",
  "entry.insert",
  "account.update",
  "term.update",
  "subscription_event.insert",
  "event.emit",
] as const;
export type LedgerStep = (typeof LEDGER_STEPS)[number];

export interface LedgerDeps {
  /** 业务时钟：账本时钟在拿到账户锁之后取它 */
  readonly clock: Clock;
  /** 出站事件：账本操作成功后在同一事务里发 */
  readonly events: Pick<Events, "emit">;
  /** 只有用例会给：每个写步骤之后调一次，抛错即在那一步中断（故障注入） */
  readonly onStep?: (step: LedgerStep) => void | Promise<void>;
}

export type LedgerRefusal =
  /** 一个事务只锁一个主体的计费账户（硬性规则 10） */
  | "one_account_per_tx"
  /** 守卫不成立：调用方给的对象不在该在的状态，或入参不合规 */
  | "guard"
  /** 同一个操作键已登记，入参与第一次不同 */
  | "op_key_conflict"
  /** 预约周期没有接在上一期的止点上 */
  | "term_chain"
  /** 写入时自检不一致：回滚，不上报、不自愈 */
  | "self_check";

/** 账本的内部错误：都是代码缺陷或数据异常，不是用户输入的问题，接口层按 500 处理。业务上的拒绝走 AppError */
export class LedgerError extends Error {
  readonly reason: LedgerRefusal;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reason: LedgerRefusal, message: string, details: Record<string, unknown> = {}) {
    super(`账本操作没有执行：${message}`);
    this.name = "LedgerError";
    this.reason = reason;
    this.details = details;
  }
}
