import { z } from "zod";
import { EVENT_PAYLOAD_SCHEMAS, InstantSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, lockRows } from "../../kernel/index.js";
import type { DeliveredEvent, Tx } from "../../kernel/index.js";
import {
  currentCalendarVersion,
  lockCalendarImport,
  SLA_UNITS,
  workHoursAt,
} from "../../sla/index.js";
import type { RefundDeps } from "./context.js";

const snapshot = z.object({
  policy: z.literal("review.refund_execute"),
  amount: z.int().nonnegative(),
  unit: z.enum(SLA_UNITS),
  calendarVersion: z.int().nonnegative(),
  computedAt: InstantSchema,
});
/** 只重算从未执行的待执行申请；不让失败回退重新开始计时。必须在同订阅其他业务锁之前调用。 */
export async function onRefundCalendarImported(tx: Tx, deps: RefundDeps, event: DeliveredEvent) {
  if (event.type !== "calendar.imported") return;
  const payload = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload);
  await lockCalendarImport(tx);
  if (payload.calendarVersion !== (await currentCalendarVersion(tx))) return;
  const rows = await tx.refundRequest.findMany({
    where: { status: "pending_execution", executedAt: null, execDueAt: { not: null } },
    include: { approvalRequest: true },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "approval_request",
    rows.map((r) => r.approvalRequestId),
  );
  await lockRows(
    tx,
    "refund_request",
    rows.map((r) => r.id),
  );
  for (const candidate of rows) {
    const row = await tx.refundRequest.findUniqueOrThrow({ where: { id: candidate.id } }),
      old = snapshot.safeParse(row.slaSnapshot);
    if (
      row.status !== "pending_execution" ||
      row.executedAt ||
      !row.execDueAt ||
      !old.success ||
      old.data.calendarVersion >= payload.calendarVersion ||
      !["work_days", "work_minutes", "same_day_cutoff"].includes(old.data.unit) ||
      !candidate.approvalRequest.decidedAt
    )
      continue;
    const from = candidate.approvalRequest.decidedAt;
    const changes = await tx.workCalendarDay.count({
      where: {
        day: {
          gte: new Date(`${calendarDate(from)}T00:00:00Z`),
          lte: new Date(`${calendarDate(row.execDueAt)}T00:00:00Z`),
        },
        calendarVersion: { gt: old.data.calendarVersion, lte: payload.calendarVersion },
      },
    });
    if (!changes) continue;
    const due = await deps.sla.dueAt(tx, {
      policy: old.data.policy,
      amount: old.data.amount,
      unit: old.data.unit,
      from,
      workHours: await workHoursAt(tx, from),
    });
    // 只需当前已预锁的审批/申请；不为时限计算获取账户或无关付款锁。
    await deps.timers.cancel(tx, {
      subject: { type: "approval_request", id: row.approvalRequestId },
      kinds: ["sla.breach"],
      keyPrefix: `sla.breach:approval_request:${row.approvalRequestId}:execution`,
    });
    await deps.flow.transition(
      tx,
      createIdentityContext({
        actor: { type: "system", job: "billing.refund_calendar_imported" },
        ...(row.entityId ? { entityId: row.entityId } : {}),
      }),
      {
        machine: "refund_request",
        stateField: "status",
        id: row.id,
        event: "sla.recalculated",
        ref: "08:533",
        ...(row.entityId ? { entityId: row.entityId } : {}),
        set: { exec_due_at: due.dueAt, sla_snapshot: due.snapshot },
        payload: {
          calendarVersion: due.snapshot.calendarVersion,
          dueAtBefore: row.execDueAt.toISOString(),
          dueAtAfter: due.dueAt.toISOString(),
        },
        args: { calendarVersion: due.snapshot.calendarVersion },
        audit: {
          stream: "ops",
          category: "refund",
          action: "finance.refund.recalculate",
          summary: "日历修正后重算退款执行时限",
          target: { type: "refund_request", id: row.id },
        },
        emit: { none: true, primary: "calendar.imported" },
      },
    );
    await deps.timers.arm(tx, {
      kind: "sla.breach",
      subject: { type: "approval_request", id: row.approvalRequestId },
      key: `sla.breach:approval_request:${row.approvalRequestId}:execution`,
      fireAt: due.dueAt,
      payload: { purpose: "execution", dueAt: due.dueAt.toISOString() },
      ...(row.entityId ? { entityId: row.entityId } : {}),
    });
  }
}
