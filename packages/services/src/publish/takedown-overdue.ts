import { addDays, atMinuteOfDay, calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { FiredTimer, Tx } from "../kernel/index.js";
import type { TransitionFacts } from "../flow/index.js";
import { timerKey } from "../timers/index.js";
import type { TakedownDeps } from "./takedown-context.js";

const escalating = new WeakMap<Tx, string>();
export async function takedownTimerGuard(tx: Tx, facts: TransitionFacts) {
  return facts.event === "takedown.escalate" && escalating.get(tx) === facts.subjectId;
}
const dateOf = (value: Date) => value.toISOString().slice(0, 10);
export async function overdueTakedown(tx: Tx, deps: TakedownDeps, timer: FiredTimer) {
  if (
    timer.kind !== "takedown.overdue" ||
    timer.subjectType !== "takedown_task" ||
    !timer.subjectId
  )
    return "skipped" as const;
  await lockRows(tx, "takedown_task", [timer.subjectId]);
  const row = await tx.takedownTask.findUnique({ where: { id: timer.subjectId } }),
    persisted = await tx.timer.findUnique({ where: { id: timer.id } }),
    now = deps.clock.now();
  if (!row || row.status !== "pending_merchant") return "skipped" as const;
  const due = dateOf(row.dueDate),
    fireAt = atMinuteOfDay(addDays(due, 1), 540);
  if (
    !persisted ||
    persisted.kind !== timer.kind ||
    persisted.subjectId !== row.id ||
    persisted.status !== "dispatched" ||
    persisted.dedupeKey !==
      timerKey("takedown.overdue", { type: "takedown_task", id: row.id }, due) ||
    persisted.fireAt.getTime() !== fireAt.getTime() ||
    timer.payload?.dueDate !== due ||
    now < fireAt ||
    calendarDate(now) <= due
  )
    return "skipped" as const;
  escalating.set(tx, row.id);
  try {
    await deps.flow.transition(
      tx,
      createIdentityContext({ actor: { type: "system", job: "takedown.overdue" } }),
      {
        machine: "takedown_task",
        stateField: "status",
        id: row.id,
        event: "takedown.escalate",
        ref: "11:659",
        entityId: row.entityId,
        storeId: row.storeId,
        set: { escalated_at: now },
        payload: { source: "timer" },
        emit: {
          type: "takedown.escalated",
          payload: { v: 1, takedownTaskId: row.id, orderItemId: row.orderItemId, dueDate: due },
        },
      },
    );
  } finally {
    escalating.delete(tx);
  }
  return "fired" as const;
}
