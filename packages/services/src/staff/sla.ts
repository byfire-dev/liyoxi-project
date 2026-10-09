import { EVENT_PAYLOAD_SCHEMAS, z } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { record } from "../audit/index.js";
import { createIdentityContext } from "../kernel/index.js";
import type { DeliveredEvent, FiredTimer, TimerOutcome, Tx } from "../kernel/index.js";
import { currentCalendarVersion, lockCalendarImport, workHoursAt } from "../sla/index.js";
import { lockStaffSet } from "./manage-full.js";
import type { StaffManagementDeps } from "./management.js";

const snapshotSchema = z.strictObject({
  policy: z.string().min(1),
  amount: z.number().nonnegative(),
  unit: z.enum(["work_minutes", "work_days", "natural_hours", "natural_days", "same_day_cutoff"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: z.iso.datetime(),
});
const keyOf = (id: string) => `sla.breach:assignment_history:${id}`;

/** This unranked history row follows its recipient staff lock; no business state machine is involved. */
async function lockHistory(tx: Tx, id: string) {
  await tx.$queryRawUnsafe(
    "SELECT id FROM assignment_history WHERE id=$1::uuid FOR NO KEY UPDATE",
    id,
  );
  return tx.assignmentHistory.findUnique({ where: { id } });
}

export async function onStaffCalendarImported(
  tx: Tx,
  deps: StaffManagementDeps,
  event: DeliveredEvent,
) {
  if (event.type !== "calendar.imported") return;
  if (!deps.sla || !deps.timers) throw new TypeError("员工联系时限尚未装配");
  const payload = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload);
  await lockCalendarImport(tx);
  if (payload.calendarVersion !== (await currentCalendarVersion(tx))) return;
  const rows = await tx.assignmentHistory.findMany({
    where: {
      source: "store_manager",
      subjectType: "store",
      contactedAt: null,
      contactVoidedAt: null,
      contactDueAt: { not: null },
    },
    orderBy: { id: "asc" },
  });
  await lockStaffSet(
    tx,
    rows.map((row) => row.toStaffId),
  );
  for (const candidate of rows) {
    const row = await lockHistory(tx, candidate.id);
    if (!row || row.contactedAt || row.contactVoidedAt || !row.contactDueAt) continue;
    const parsed = snapshotSchema.safeParse(row.slaSnapshot);
    if (!parsed.success) throw new TypeError("联系时限快照不合法");
    const snapshot = parsed.data;
    if (
      snapshot.calendarVersion >= payload.calendarVersion ||
      !["work_days", "work_minutes", "same_day_cutoff"].includes(snapshot.unit)
    )
      continue;
    const changed = await tx.workCalendarDay.count({
      where: {
        day: {
          gte: new Date(`${calendarDate(row.createdAt)}T00:00:00Z`),
          lte: new Date(`${calendarDate(row.contactDueAt)}T00:00:00Z`),
        },
        calendarVersion: { gt: snapshot.calendarVersion, lte: payload.calendarVersion },
      },
    });
    if (!changed) continue;
    const next = await deps.sla.dueAt(tx, {
      ...snapshot,
      from: row.createdAt,
      workHours: await workHoursAt(tx, row.createdAt),
    });
    await deps.timers.cancel(tx, {
      subject: { type: "assignment_history", id: row.id },
      kinds: ["sla.breach"],
    });
    await tx.assignmentHistory.update({
      where: { id: row.id },
      data: {
        contactDueAt: next.dueAt,
        slaSnapshot: { ...next.snapshot },
        updatedAt: deps.clock.now(),
      },
    });
    const ctx = createIdentityContext({
      actor: { type: "system", job: "staff.calendar_imported" },
    });
    await record(
      tx,
      ctx.actor,
      {
        requestId: null,
        ip: null,
        userAgent: null,
        sessionId: null,
        authMethod: "system",
        jobName: "staff.calendar_imported",
      },
      {
        stream: "ops",
        category: "manager_assign",
        action: "staff.assignment.recalculate",
        summary: "日历修正后重算联系时限",
        target: { type: "assignment_history", id: row.id },
        before: { contactDueAt: row.contactDueAt.toISOString() },
        after: { contactDueAt: next.dueAt.toISOString() },
        fields: ["contactDueAt"],
      },
    );
    await deps.timers.arm(tx, {
      kind: "sla.breach",
      subject: { type: "assignment_history", id: row.id },
      fireAt: next.dueAt,
      key: keyOf(row.id),
      payload: { dueAt: next.dueAt.toISOString() },
    });
  }
}

export async function handleStaffSlaBreach(
  tx: Tx,
  deps: StaffManagementDeps,
  timer: FiredTimer,
): Promise<TimerOutcome> {
  if (timer.subjectType !== "assignment_history" || !timer.subjectId) return "skipped";
  if (!deps.events) throw new TypeError("员工事件尚未装配");
  const candidate = await tx.assignmentHistory.findUnique({ where: { id: timer.subjectId } });
  if (!candidate) return "skipped";
  await lockStaffSet(tx, [candidate.toStaffId]);
  const row = await lockHistory(tx, candidate.id);
  const persisted = await tx.timer.findUnique({ where: { id: timer.id } });
  if (
    !row ||
    row.source !== "store_manager" ||
    row.subjectType !== "store" ||
    !row.contactDueAt ||
    row.contactedAt ||
    row.contactVoidedAt ||
    !persisted ||
    persisted.status !== "dispatched"
  )
    return "skipped";
  const snapshot = snapshotSchema.safeParse(row.slaSnapshot);
  if (!snapshot.success) throw new TypeError("联系时限快照不合法");
  if (
    persisted.dedupeKey !== keyOf(row.id) ||
    persisted.fireAt.getTime() !== row.contactDueAt.getTime() ||
    row.contactDueAt > deps.clock.now() ||
    timer.payload?.dueAt !== row.contactDueAt.toISOString()
  )
    return "skipped";
  const ctx = createIdentityContext({ actor: { type: "system", job: "staff.sla_breach" } });
  await deps.events.emit(tx, ctx, {
    type: "assignment.sla_breached",
    aggregate: { type: "assignment_history", id: row.id },
    dedupeKey: `tmr:${persisted.dedupeKey}`,
    payload: {
      v: 1,
      assignmentHistoryId: row.id,
      storeId: row.subjectId,
      toStaffId: row.toStaffId,
      contactDueAt: row.contactDueAt.toISOString(),
    },
  });
  return "fired";
}

export const assignmentContactTimerKey = keyOf;
