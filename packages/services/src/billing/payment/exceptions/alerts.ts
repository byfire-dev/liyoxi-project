import { addDays, calendarDate } from "@liyoxi/shared/time";
import { addWorkingDays } from "@liyoxi/shared/workcal";
import type { Tx } from "../../../kernel/index.js";
import { loadWorkCalendar, workHoursAt } from "../../../sla/index.js";
import { OPEN } from "./context.js";

/** ops只消费只读标量事实；不外呼、不入账、不在GET里触发告警。 */
export async function readPaymentExceptionAlertFacts(tx: Tx, at: Date) {
  const groups = await tx.paymentException.groupBy({
    by: ["kind"],
    where: { status: { in: OPEN } },
    _count: { id: true },
    _min: { createdAt: true },
  });
  const unresolved = groups.reduce((n, g) => n + g._count.id, 0);
  const critical = groups
    .filter((g) => ["refund_over", "entitlement_unrecovered"].includes(g.kind))
    .reduce((n, g) => n + g._count.id, 0);
  const oldest = groups.reduce<Date | null>(
    (min, g) => (g._min.createdAt && (!min || g._min.createdAt < min) ? g._min.createdAt : min),
    null,
  );
  if (!oldest) return { unresolved, critical, overdue: false, oldestDueAt: null };
  const calendar = await loadWorkCalendar(
    tx,
    { from: calendarDate(oldest), to: addDays(calendarDate(at), 14) },
    await workHoursAt(tx, at),
  );
  const due = addWorkingDays(calendar, oldest, 1).at;
  return { unresolved, critical, overdue: due < at, oldestDueAt: due.toISOString() };
}
export type PaymentExceptionAlertFacts = Awaited<ReturnType<typeof readPaymentExceptionAlertFacts>>;
