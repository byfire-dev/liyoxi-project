import { DateSchema } from "@liyoxi/contract";
import { addDays } from "@liyoxi/shared/time";
import { assertNotInTransaction } from "../kernel/index.js";
import type { Clock, TxRunner } from "../kernel/index.js";
import { writeAlertFact, writeHealthyProbeFact } from "./alert-facts.js";

/** 仅由组合根注入账单任务；真实缺账/parsed观测走原probe writer与三次正常恢复。 */
export function createBillMissingObserver(deps: { tx: TxRunner; clock: Clock }) {
  return async (day: string, ready: boolean) => {
    assertNotInTransaction("账单告警观测要求独立事务");
    DateSchema.parse(day);
    const at = deps.clock.now(),
      input = { rule: "billing.bill_missing", dimension: day };
    if (at < new Date(`${addDays(day, 1)}T14:00:00+08:00`))
      throw new TypeError("账单告警观测早于截止时刻");
    await deps.tx.run(async (tx) => {
      if (ready) await writeHealthyProbeFact(tx, input, at, at);
      else
        await writeAlertFact(
          tx,
          { ...input, severity: "P2", detail: { billDate: day } },
          "probe",
          at,
          at,
        );
    });
  };
}
