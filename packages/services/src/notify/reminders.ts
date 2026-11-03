import { addDays, atMinuteOfDay, calendarDate, dayRange, minuteOfDay } from "@liyoxi/shared/time";
import { IdSchema, DateSchema, z } from "@liyoxi/contract";
import { notifyReadOf, remindersOf } from "../kernel/index.js";
import type { RecurringRunContext, Tx } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import { currentNotificationFact, dispatchFact } from "./dispatch.js";
import {
  AD_PENDING_SPEC,
  EVENT_SCENES,
  FOLLOWUP_SPEC,
  COPYRIGHT_SPEC,
  RENEWAL_SPEC,
  LAUNCH_REMINDER_SPEC,
  LAUNCH_OVERDUE_SPEC,
  TAKEDOWN_REMINDER_SPEC,
  NotifyFactSchema,
} from "./registry.js";

/** Real pending-action and staff facts; no placeholder future business scanners. */
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
  if (minuteOfDay(now) >= 9 * 60 && minuteOfDay(now) <= 9 * 60 + grace * 60) {
    const date = calendarDate(now);
    for (const rule of ["R2", "R3", "R6"] as const) {
      if (!reminders.has(rule)) throw new Error(`${rule} 缺少真实上线查询登记`);
      const queries =
        rule === "R2"
          ? (await deps.params.get("remind.launch.days")).map((days) => ({
              launchDate: addDays(date, days),
              node: `T-${days}`,
            }))
          : rule === "R3"
            ? (await deps.params.get("remind.offline.days")).map((days) => ({
                usageEndDate: addDays(date, days),
                node: `T-${days}`,
              }))
            : [{ date, node: "N0" }];
      for (const query of queries) {
        const rows = await run((tx) => reminders.targets(tx, rule, query));
        for (const row of rows) {
          if (context.signal?.aborted) break;
          notifications += await run(async (tx) => {
            const current = await reminders.revalidate(tx, rule, { ...row, now });
            if (!current.valid || !current.vars) return 0;
            const fact = NotifyFactSchema.parse(current.vars);
            targets++;
            return dispatchFact(
              tx,
              deps,
              rule === "R2"
                ? LAUNCH_REMINDER_SPEC
                : rule === "R3"
                  ? TAKEDOWN_REMINDER_SPEC
                  : LAUNCH_OVERDUE_SPEC,
              fact,
              { node: query.node, rule },
            );
          });
        }
      }
    }
  }
  if (reminders.has("R1")) {
    const shape = z.strictObject({
      termId: IdSchema,
      node: z.string().regex(/^T-\d+$/),
      date: DateSchema,
    });
    const rows = (await run((tx) => reminders.targets(tx, "R1", { now }))).map((value) =>
      shape.parse(value),
    );
    for (const target of rows) {
      if (context.signal?.aborted) break;
      notifications += await run(async (tx) => {
        if (!(await reminders.revalidate(tx, "R1", { ...target, now })).valid) return 0;
        const fact = await currentNotificationFact(tx, deps, RENEWAL_SPEC, target.termId);
        if (!fact) return 0;
        targets++;
        return dispatchFact(tx, deps, RENEWAL_SPEC, fact, { node: target.node, rule: "R1" });
      });
    }
  }
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
  if (reminders.has("R5") && minuteOfDay(now) <= grace * 60) {
    // R5 is the existing two-natural-day ad node, independent of sample's configurable delay.
    const adRange = dayRange(addDays(calendarDate(now), -2));
    const ads = await run((tx) =>
      reminders.targets(tx, "R5", {
        pushedFrom: adRange.start,
        pushedTo: new Date(adRange.end.getTime() - 1),
      }),
    );
    for (const item of ads) {
      if (context.signal?.aborted) break;
      notifications += await run(async (tx) => {
        if (!(await reminders.revalidate(tx, "R5", item)).valid) return 0;
        const fact = await currentNotificationFact(
          tx,
          deps,
          AD_PENDING_SPEC,
          IdSchema.parse(item.adId),
        );
        if (!fact || fact.version !== item.version) return 0;
        targets++;
        return dispatchFact(tx, deps, AD_PENDING_SPEC, fact, { node: "R1", rule: "R5" });
      });
    }
  }
  const copyrightNode = 9 * 60 + 5,
    minute = minuteOfDay(now);
  if (
    reminders.has("R7") &&
    minute >= copyrightNode &&
    minute <= copyrightNode + grace * 60 &&
    deps.copyrightRecipients
  ) {
    const date = calendarDate(now),
      end = addDays(date, await deps.params.get("remind.copyright.days"));
    const shape = z.strictObject({
      dramaId: IdSchema,
      title: z.string().refine((value) => [...value].length <= 20),
      licenseEndDate: DateSchema,
    });
    notifications += await run(async (tx) => {
      const dramas = (await reminders.targets(tx, "R7", { date: end })).map((row) =>
        shape.parse(row),
      );
      if (!dramas.length || context.signal?.aborted) return 0;
      const staffIds = await deps.copyrightRecipients!(tx);
      let made = 0;
      const summary = `${dramas.length}部短剧的授权将于${end}结束：${dramas.map((row) => row.title).join("、")}`;
      for (const staffId of staffIds) {
        if (context.signal?.aborted) break;
        targets++;
        made += await dispatchFact(
          tx,
          deps,
          COPYRIGHT_SPEC,
          {
            bizType: "staff",
            bizId: staffId,
            entityId: null,
            storeId: null,
            status: "copyright_expiring",
            version: 0,
            name: "版权到期提醒",
            targetDate: date,
            staffIds: [staffId],
            quantity: dramas.length,
            summary: summary.slice(0, 200),
          },
          { node: "N0", rule: "R7" },
        );
      }
      return made;
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
