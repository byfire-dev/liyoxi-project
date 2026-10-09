import { addDays, atMinuteOfDay, calendarDate, dayRange, minuteOfDay } from "@liyoxi/shared/time";
import { IdSchema } from "@liyoxi/contract";
import { notifyReadOf, remindersOf } from "../kernel/index.js";
import type { RecurringRunContext, Tx } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import { currentNotificationFact, dispatchFact } from "./dispatch.js";
import { EVENT_SCENES, FOLLOWUP_SPEC } from "./registry.js";

/** Only R4 and existing staff facts are implemented; future business scanners remain unregistered. */
export async function remindScan(deps: NotifyDispatchDeps, context: RecurringRunContext) {
  const run = context.runTx ?? deps.tx.run;
  const now = deps.clock.now();
  const elapsedDays = await deps.params.get("remind.sample.after_days");
  const grace = await deps.params.get("remind.grace_hours");
  const range = dayRange(addDays(calendarDate(now), -elapsedDays));
  const from = range.start;
  const to = new Date(range.end.getTime() - 1);
  const reminders = remindersOf(deps.assembly);
  if (!reminders.has("R4")) throw new Error("R4 缺少真实样片查询登记");
  // A natural-day node is midnight in Shanghai, with the original bounded catch-up grace.
  const samples =
    minuteOfDay(now) <= grace * 60
      ? await run((tx) => reminders.targets(tx, "R4", { pushedFrom: from, pushedTo: to }))
      : [];
  let targets = 0;
  let notifications = 0;
  for (const item of samples) {
    if (context.signal?.aborted) break;
    notifications += await run(async (tx) => {
      if (!(await reminders.revalidate(tx, "R4", item)).valid) return 0;
      const spec = EVENT_SCENES["sample.pushed"]![0]!;
      const fact = await currentNotificationFact(tx, deps, spec, IdSchema.parse(item.sampleId));
      if (!fact) return 0;
      targets++;
      return dispatchFact(tx, deps, spec, fact, { node: "R1", rule: "R4" });
    });
  }
  const read = notifyReadOf(deps.assembly);
  for (const [key, spec] of [
    ["pendingApprovalsForNotify", EVENT_SCENES["approval.submitted"]![0]!],
    ["followUpsDueForNotify", FOLLOWUP_SPEC],
  ] as const) {
    if (context.signal?.aborted) break;
    if (!read.has(key)) throw new Error(`员工提醒缺少真实查询登记：${key}`);
    const rows = await run((tx) => read.read<{ id: string }[]>(tx, key, now));
    for (const row of rows ?? []) {
      if (context.signal?.aborted) break;
      notifications += await run(async (tx: Tx) => {
        const fact = await currentNotificationFact(tx, deps, spec, row.id);
        if (
          !fact ||
          (spec === FOLLOWUP_SPEC &&
            (!fact.targetDate || now < atMinuteOfDay(fact.targetDate, 9 * 60)))
        )
          return 0;
        targets++;
        return dispatchFact(tx, deps, spec, fact, {
          node: "N0",
          rule: spec === FOLLOWUP_SPEC ? "followup_due" : "approval_pending",
        });
      });
    }
  }
  return { targets, notifications, scheduledDate: calendarDate(context.scheduledFor) };
}
