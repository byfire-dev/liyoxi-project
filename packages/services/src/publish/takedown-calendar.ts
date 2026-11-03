import { EVENT_PAYLOAD_SCHEMAS, z } from "@liyoxi/contract";
import { calendarDate, endOfDay } from "@liyoxi/shared/time";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import type { TransitionFacts } from "../flow/index.js";
import { currentCalendarVersion, lockCalendarImport, workHoursAt } from "../sla/index.js";
import type { TakedownDeps } from "./takedown-context.js";

const recalculating = new WeakMap<Tx, string>();
const snapshotSchema = z.object({
  policy: z.string(),
  amount: z.number().nonnegative(),
  unit: z.enum(["work_days", "work_minutes", "same_day_cutoff", "natural_days", "natural_hours"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: z.iso.datetime(),
});
export async function takedownCalendarGuard(tx: Tx, facts: TransitionFacts) {
  return facts.event === "sla.recalculated" && recalculating.get(tx) === facts.subjectId;
}

/** Calendar imports only change the checking SLA, never the licensed usage date. */
export async function onTakedownCalendarImported(
  tx: Tx,
  deps: TakedownDeps,
  event: DeliveredEvent,
) {
  if (event.type !== "calendar.imported") return;
  const payload = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload);
  await lockCalendarImport(tx);
  if (payload.calendarVersion !== (await currentCalendarVersion(tx))) return;
  const candidates = await tx.takedownTask.findMany({
    where: { status: "merchant_confirmed" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "takedown_task",
    candidates.map((r) => r.id),
  );
  for (const candidate of candidates) {
    const row = await tx.takedownTask.findUniqueOrThrow({ where: { id: candidate.id } });
    if (row.status !== "merchant_confirmed" || !row.merchantConfirmedAt || !row.checkDueAt)
      continue;
    const parsed = snapshotSchema.safeParse(row.slaSnapshot);
    if (!parsed.success) throw new TypeError("下架核查时限快照不合法");
    const snapshot = parsed.data;
    if (
      snapshot.calendarVersion >= payload.calendarVersion ||
      !["work_days", "work_minutes", "same_day_cutoff"].includes(snapshot.unit)
    )
      continue;
    const from = new Date(
      Math.max(
        row.merchantConfirmedAt.getTime(),
        endOfDay(row.dueDate.toISOString().slice(0, 10)).getTime(),
      ),
    );
    const changed = await tx.workCalendarDay.count({
      where: {
        day: { gte: new Date(calendarDate(from)), lte: new Date(calendarDate(row.checkDueAt)) },
        calendarVersion: { gt: snapshot.calendarVersion, lte: payload.calendarVersion },
      },
    });
    if (!changed) continue;
    const result = await deps.sla.dueAt(tx, {
      policy: snapshot.policy,
      amount: snapshot.amount,
      unit: snapshot.unit,
      from,
      workHours: await workHoursAt(tx, row.merchantConfirmedAt),
    });
    recalculating.set(tx, row.id);
    try {
      await deps.flow.transition(
        tx,
        createIdentityContext({ actor: { type: "system", job: "publish.calendar_imported" } }),
        {
          machine: "takedown_task",
          stateField: "status",
          id: row.id,
          event: "sla.recalculated",
          ref: "11:671",
          entityId: row.entityId,
          storeId: row.storeId,
          set: { check_due_at: result.dueAt, sla_snapshot: { ...result.snapshot } },
          payload: {
            calendarVersion: result.snapshot.calendarVersion,
            dueAtBefore: row.checkDueAt.toISOString(),
            dueAtAfter: result.dueAt.toISOString(),
          },
          audit: {
            stream: "activity",
            category: "delivery",
            action: "publish.takedown_task.recalculate",
            summary: "日历修正后重算下架核查时限",
            target: { type: "takedown_task", id: row.id },
            entityId: row.entityId,
            storeId: row.storeId,
            before: { checkDueAt: row.checkDueAt.toISOString(), slaSnapshot: snapshot },
            after: { checkDueAt: result.dueAt.toISOString(), slaSnapshot: { ...result.snapshot } },
            fields: ["checkDueAt", "slaSnapshot"],
          },
          emit: { none: true, primary: "calendar.imported" },
        },
      );
    } finally {
      recalculating.delete(tx);
    }
  }
}
