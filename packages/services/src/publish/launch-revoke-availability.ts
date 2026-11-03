import { addDays, calendarDate } from "@liyoxi/shared/time";
import { dueAt } from "@liyoxi/shared/workcal";
import { hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import type { Tx } from "../kernel/index.js";
import { loadWorkCalendar, workHoursAt } from "../sla/index.js";
import type { TaskRow } from "./repo.js";

/** Same calendar computation as SLA, without its missing-calendar alert side effect on GET. */
export async function revokeDeadline(tx: Tx, decidedAt: Date, now: Date) {
  const policy = (await paramsAt(tx, ["launch.verify_revoke_window"], now))[
    "launch.verify_revoke_window"
  ];
  const hours = await workHoursAt(tx, now),
    from = calendarDate(decidedAt);
  const needDays = policy.unit === "work_days" ? policy.amount * 2 : Math.ceil(policy.amount / 60);
  for (let span = Math.max(45, needDays); ; span *= 4) {
    const to = addDays(from, span);
    const value = dueAt(await loadWorkCalendar(tx, { from, to }, hours), decidedAt, policy);
    if (span >= 2880 || value.fallbackDates.every((date) => date <= to)) return value.at;
  }
}

export async function launchRevokeAvailability(
  tx: Tx,
  task: TaskRow,
  id: string,
  staff: StaffContext,
  now: Date,
) {
  const row = task.launchSubmissions.find((r) => r.id === id);
  if (!row || !["passed", "passed_partial"].includes(row.result)) return null;
  const reasons: string[] = [];
  const latest = task.launchSubmissions.find((r) =>
    ["passed", "passed_partial"].includes(r.result),
  );
  if (latest?.id !== id) reasons.push("not_latest_passed");
  if (task.reviewStatus !== "passed") reasons.push("task_not_passed");
  if (task.deliveryTicket.step !== "in_service") reasons.push("ticket_not_in_service");
  if (task.deliveryTicket.pauseCount > 0) reasons.push("ticket_on_hold");
  const deadline = row.approvalRequest.decidedAt
    ? await revokeDeadline(tx, row.approvalRequest.decidedAt, now)
    : null;
  if (!deadline || now > deadline) reasons.push("window_closed");
  if (
    await tx.takedownTask.count({
      where: {
        orderItemId: task.orderItemId,
        OR: [{ merchantConfirmedAt: { not: null } }, { status: "checked" }],
      },
    })
  )
    reasons.push("takedown_confirmed");
  return {
    canRevoke: reasons.length === 0 && hasPermission(staff, "publish.link.verify_revoke"),
    deadlineAt: deadline?.toISOString() ?? null,
    blockedReasons: reasons,
  };
}
