import { IdSchema } from "@liyoxi/contract";
import { addDays, calendarDate, diffDays, startOfDay } from "@liyoxi/shared/time";
import type { ReminderQuery, ReminderTarget, Tx } from "../../kernel/index.js";
import { fromDateColumn } from "../ledger/context.js";
import { paramsAt } from "../pricing/index.js";

export async function renewalApplicable(tx: Tx, id: string, now: Date) {
  const term = await tx.subscriptionTerm.findUnique({ where: { id } });
  if (
    !term ||
    !["active", "ended"].includes(term.status) ||
    term.refundRequestId !== null ||
    term.endsAt <= startOfDay(addDays(calendarDate(now), -30))
  )
    return false;
  return (
    (await tx.subscriptionTerm.count({
      where: {
        entityId: term.entityId,
        termNo: { gt: term.termNo },
        status: { in: ["active", "scheduled", "ended"] },
      },
    })) === 0
  );
}

/** R1真实到期节点，只读；通知模块持有去重、当前老板与发送窗口。 */
export async function listTermsDueForReminder(
  tx: Tx,
  query: ReminderQuery,
): Promise<readonly ReminderTarget[]> {
  if (!(query.now instanceof Date) || !Number.isFinite(query.now.getTime()))
    throw new TypeError("R1要求真实扫描时刻");
  const now = query.now,
    today = calendarDate(now),
    params = await paramsAt(tx, now);
  const days = [...new Set([0, ...params.renewalReminderDays])];
  const terms = await tx.subscriptionTerm.findMany({
    where: {
      status: "active",
      startsAt: { lte: now },
      endsAt: { gt: now },
      endDate: { in: days.map((n) => new Date(`${addDays(today, n)}T00:00:00Z`)) },
      refundRequestId: null,
    },
    orderBy: [{ endDate: "asc" }, { id: "asc" }],
  });
  const targets: ReminderTarget[] = [];
  for (const term of terms) {
    if (!(await renewalApplicable(tx, term.id, now))) continue;
    const distance = diffDays(fromDateColumn(term.endDate), today);
    const node = `T-${distance}`;
    if (startOfDay(today) < term.startsAt) continue;
    targets.push({ termId: term.id, node, date: today });
  }
  return targets;
}

export async function revalidateRenewal(tx: Tx, target: ReminderTarget) {
  const id = IdSchema.parse(target.termId);
  if (!(target.now instanceof Date)) return { valid: false };
  return { valid: await renewalApplicable(tx, id, target.now) };
}
