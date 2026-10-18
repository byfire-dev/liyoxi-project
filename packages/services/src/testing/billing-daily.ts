import { addDays, calendarDate } from "@liyoxi/shared/time";
import { createBillingDailyProjection, createLedger } from "../billing/index.js";
import type { Clock, TxRunner } from "../kernel/index.js";
import type { Events } from "../events/index.js";

/** 跨日场景显式补跑闭日派生准备；不推进账户、不补源历史，不改变后续不变量判据。 */
export async function prepareClosedBillingDays(
  deps: { clock: Clock; tx: TxRunner; events: Events },
  entityId?: string,
) {
  const through = addDays(calendarDate(deps.clock.now()), -1);
  const ledger = createLedger({ clock: deps.clock, events: deps.events });
  const projection = createBillingDailyProjection({ ledger });
  const accounts = await deps.tx.run((tx) =>
    tx.billingAccount.findMany({
      where: entityId === undefined ? {} : { entityId },
      select: { entityId: true },
      orderBy: { entityId: "asc" },
    }),
  );
  for (const account of accounts)
    await deps.tx.run((tx) => projection.snapshot(tx, account.entityId, through));
}
