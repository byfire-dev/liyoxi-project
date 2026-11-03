import { timerKey } from "../timers/index.js";
import { calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { InvariantViolation, Tx } from "../kernel/index.js";
import type { PatrolDeps } from "./patrol-context.js";
import { patrolOf, patrolInclude } from "./patrol-repo.js";
import { closeSystemFollowUps } from "../staff/index.js";
import type { TransitionFacts } from "../flow/index.js";
const active = new WeakSet<Tx>();
const open = (status: string) => ["pending", "abnormal"].includes(status);
function obsolete(row: Awaited<ReturnType<typeof patrolOf>>, now: Date) {
  return (
    !row.launchTask.isLive ||
    row.launchTask.reviewStatus === "void" ||
    ["terminated", "refunded", "ended"].includes(row.orderItem.phase) ||
    (!!row.orderItem.usageEndDate &&
      row.orderItem.usageEndDate.toISOString().slice(0, 10) < calendarDate(now))
  );
}
export async function patrolRepairGuard(tx: Tx, facts: TransitionFacts) {
  return active.has(tx) && facts.event === "patrol.void";
}
export async function patrolOwnershipViolations(tx: Tx): Promise<InvariantViolation[]> {
  const rows = await tx.patrolTask.findMany({ include: { launchTask: true } });
  return rows
    .filter(
      (r) =>
        r.entityId !== r.launchTask.entityId ||
        r.storeId !== r.launchTask.storeId ||
        r.orderItemId !== r.launchTask.orderItemId ||
        r.deliveryTicketId !== r.launchTask.deliveryTicketId,
    )
    .map((r) => ({
      subject: { type: "patrol_task", id: r.id },
      entityId: r.entityId,
      detail: { launchTaskId: r.launchTaskId, scopeMismatch: true },
    }));
}
export async function patrolObsoleteViolations(tx: Tx, now: Date): Promise<InvariantViolation[]> {
  const rows = await tx.patrolTask.findMany({
    where: { status: { in: ["pending", "abnormal"] } },
    include: patrolInclude,
  });
  return rows
    .filter((row) => obsolete(row, now))
    .map((row) => ({
      subject: { type: "patrol_task", id: row.id },
      entityId: row.entityId,
      detail: { status: row.status, obsolete: true },
    }));
}
/** Idempotent repair under the same parent locks as all patrol writers. */
export async function repairPatrols(
  tx: Tx,
  deps: PatrolDeps,
  now: Date,
): Promise<InvariantViolation[]> {
  const rows = await tx.patrolTask.findMany({
    where: { status: { in: ["pending", "abnormal"] } },
    orderBy: { launchTaskId: "asc" },
  });
  const parents = await tx.launchTask.findMany({
    where: { id: { in: rows.map((r) => r.launchTaskId) } },
    include: { orderItem: true },
  });
  await lockRows(
    tx,
    "drama_order",
    [...new Set(parents.map((r) => r.orderItem.dramaOrderId))].sort(),
  );
  await lockRows(tx, "order_item", [...new Set(parents.map((r) => r.orderItemId))].sort());
  await lockRows(
    tx,
    "delivery_ticket",
    [...new Set(parents.map((r) => r.deliveryTicketId))].sort(),
  );
  await lockRows(tx, "launch_task", parents.map((r) => r.id).sort());
  await lockRows(tx, "patrol_task", rows.map((r) => r.id).sort());
  const ctx = createIdentityContext({ actor: { type: "system", job: "publish.patrol_reconcile" } });
  const violations: InvariantViolation[] = [];
  for (const initial of rows) {
    const row = await patrolOf(tx, initial.id);
    if (!open(row.status) || !obsolete(row, now)) continue;
    active.add(tx);
    try {
      await deps.flow.transition(tx, ctx, {
        machine: "patrol_task",
        stateField: "status",
        id: row.id,
        event: "patrol.void",
        ref: "11:547",
        entityId: row.entityId,
        storeId: row.storeId,
        emit: { type: "patrol.voided", payload: { v: 1, patrolTaskId: row.id } },
      });
      await deps.timers.cancel(tx, {
        subject: { type: "patrol_task", id: row.id },
        kinds: ["patrol.followup"],
      });
      await closeSystemFollowUps(tx, ctx, {
        subjects: [{ subjectType: "patrol_task", subjectId: row.id }],
        now,
      });
    } finally {
      active.delete(tx);
    }
    violations.push({
      subject: { type: "patrol_task", id: row.id },
      entityId: row.entityId,
      detail: { status: row.status, obsolete: true },
      healed: { action: "作废失效巡检并关闭跟进", at: now },
    });
  }
  return violations;
}

/** timers.I7 contribution for patrol only; completed timer history is never rewritten. */
export async function repairPatrolTimers(
  tx: Tx,
  deps: PatrolDeps,
  now: Date,
): Promise<InvariantViolation[]> {
  const abnormal = await tx.patrolTask.findMany({
    where: { status: "abnormal" },
    select: { id: true },
  });
  const liveTimers = await tx.timer.findMany({
    where: {
      kind: "patrol.followup",
      subjectType: "patrol_task",
      status: { in: ["scheduled", "dispatched"] },
    },
  });
  const ids = [
    ...new Set([
      ...abnormal.map((r) => r.id),
      ...liveTimers.flatMap((r) => (r.subjectId ? [r.subjectId] : [])),
    ]),
  ].sort();
  await lockRows(tx, "patrol_task", ids);
  const violations: InvariantViolation[] = [];
  for (const id of ids) {
    const row = await tx.patrolTask.findUnique({ where: { id } });
    const subject = { type: "patrol_task", id };
    if (row?.status === "abnormal") {
      if (!row.foundAt) throw new TypeError("异常巡检缺少发现时间");
      const fireAt = new Date(row.foundAt.getTime() + 3 * 86400000);
      // Once due, the delivery/retry lifecycle owns completion; do not reset retry state.
      if (
        fireAt <= now ||
        (await tx.timer.findFirst({
          where: {
            kind: "patrol.followup",
            subjectType: subject.type,
            subjectId: id,
            status: { not: "cancelled" },
          },
        }))
      )
        continue;
      await deps.timers.arm(tx, {
        kind: "patrol.followup",
        subject,
        key: timerKey("patrol.followup", subject),
        fireAt,
        entityId: row.entityId,
        storeId: row.storeId,
      });
      violations.push({
        subject,
        entityId: row.entityId,
        detail: { kind: "patrol.followup", missing: true },
        healed: { action: "补登记巡检异常跟进", at: now },
      });
    } else {
      const timers = await tx.timer.findMany({
        where: {
          kind: "patrol.followup",
          subjectType: subject.type,
          subjectId: id,
          status: { in: ["scheduled", "dispatched"] },
        },
      });
      if (!timers.length) continue;
      await deps.timers.cancel(tx, { subject, kinds: ["patrol.followup"] });
      for (const timer of timers) {
        const entityId = row?.entityId ?? timer.entityId;
        if (!entityId) throw new TypeError("孤儿巡检定时器缺少主体归属");
        violations.push({
          subject: { type: "timer", id: timer.id },
          entityId,
          detail: { kind: "patrol.followup", orphan: true },
          healed: { action: "取消失效巡检跟进", at: now },
        });
      }
    }
  }
  return violations;
}
