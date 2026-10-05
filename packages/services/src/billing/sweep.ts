// 账务推进的每分钟扫描（W1-10）：循环 billing_advance 的用例函数。依据：x01 第 4.3 节“账务推进”行；D1 第 6.2、8.4 节。
// 取 next_due_at 已到的主体，逐个开事务：账户被别的事务占着就跳过（它自己会推进，或下一分钟再来），拿到就 advance。
// 多个实例同时扫也安全：SKIP LOCKED 加 advance 幂等。Redis 不可用时照跑（只依赖 PostgreSQL）。
// 一个主体出错不影响别的主体：记下、经告警端口报一条，它的 next_due_at 不前进，下一轮再试。
import type { Alerts, Clock, TxRunner } from "../kernel/index.js";
import type { Db, Ledger } from "./ledger/index.js";

/** 一轮至多处理多少个主体（D1 第 6.2 节） */
export const ADVANCE_SWEEP_LIMIT = 200;

export interface AdvanceSweepDeps {
  /** 扫描用的只读连接 */
  readonly db: Db;
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly ledger: Pick<Ledger, "advance">;
  /** 不给即不报告警（用例） */
  readonly alerts?: Alerts;
}

export interface AdvanceSweepOptions {
  readonly limit?: number;
  /** 每处理完一个主体调一次：循环的看门狗据此知道还有进展 */
  readonly beat?: () => void;
}

export interface AdvanceSweepResult {
  /** 这一轮取到的到点主体数 */
  readonly due: number;
  /** 推进了的 */
  readonly advanced: number;
  /** 账户被占着、这一轮跳过的 */
  readonly skipped: number;
  /** 出错的主体 */
  readonly failed: readonly string[];
}

export async function advanceDueAccounts(
  deps: AdvanceSweepDeps,
  options: AdvanceSweepOptions = {},
): Promise<AdvanceSweepResult> {
  const limit = options.limit ?? ADVANCE_SWEEP_LIMIT;
  const due = await deps.db.$queryRaw<{ id: string }[]>`
    SELECT entity_id::text AS id FROM billing_account
    WHERE next_due_at <= ${deps.clock.now()}
    ORDER BY next_due_at, entity_id
    LIMIT ${limit}`;
  let advanced = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const { id } of due) {
    try {
      const summary = await deps.tx.run((tx) => deps.ledger.advance(tx, id, { wait: "skip" }));
      if (summary === null) skipped += 1;
      else advanced += 1;
    } catch (error) {
      failed.push(id);
      await deps.alerts?.raise({
        rule: "billing.advance_failed",
        dimension: id,
        severity: "P1",
        detail: { entityId: id, error: error instanceof Error ? error.message : String(error) },
      });
    }
    options.beat?.();
  }
  return { due: due.length, advanced, skipped, failed };
}
