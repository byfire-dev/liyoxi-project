import { EVENT_PAYLOAD_SCHEMAS, z } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { record } from "../audit/index.js";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import {
  currentCalendarVersion,
  lockCalendarImport,
  SLA_UNITS,
  workHoursAt,
} from "../sla/index.js";
import type { OrderStartBinding } from "./start-binding.js";

const snapshot = z.object({
  policy: z.string().min(1),
  amount: z.number().nonnegative(),
  unit: z.enum(SLA_UNITS),
  calendarVersion: z.int().nonnegative(),
  computedAt: z.iso.datetime(),
});
type Snapshot = z.infer<typeof snapshot>;
async function changed(tx: Tx, s: Snapshot, from: Date, due: Date, version: number) {
  return (
    s.calendarVersion < version &&
    ["work_days", "work_minutes", "same_day_cutoff"].includes(s.unit) &&
    (await tx.workCalendarDay.count({
      where: {
        day: { gte: new Date(calendarDate(from)), lte: new Date(calendarDate(due)) },
        calendarVersion: { gt: s.calendarVersion, lte: version },
      },
    })) > 0
  );
}
/** Calendar imports share the same advisory boundary as each original SLA calculation. */
export async function onOrderCalendarImported(
  tx: Tx,
  deps: OrderStartBinding,
  event: DeliveredEvent,
) {
  if (event.type !== "calendar.imported") return;
  const { calendarVersion } = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload);
  await lockCalendarImport(tx);
  if (calendarVersion !== (await currentCalendarVersion(tx))) return;
  const requests = await tx.cancelRequest.findMany({
      where: {
        status: "pending_execution",
        executedAt: null,
        closedAt: null,
        execDueAt: { not: null },
      },
      include: { approvalRequest: true },
      orderBy: { id: "asc" },
    }),
    ads = await tx.ad.findMany({
      where: {
        status: { in: ["pending_assign", "producing", "revising"] },
        openCancelRequestId: null,
        dueAt: { not: null },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
  await lockRows(
    tx,
    "approval_request",
    requests.map((r) => r.approvalRequestId),
  );
  await lockRows(
    tx,
    "cancel_request",
    requests.map((r) => r.id),
  );
  await lockRows(
    tx,
    "ad",
    ads.map((r) => r.id),
  );
  const ctx = createIdentityContext({ actor: { type: "system", job: "order.calendar_imported" } });
  const audit = async (
    type: "cancel_request" | "ad",
    id: string,
    entityId: string,
    storeId: string,
    before: Date,
    after: Date,
  ) =>
    record(
      tx,
      ctx.actor,
      {
        requestId: ctx.requestId,
        ip: null,
        userAgent: null,
        authMethod: null,
        sessionId: null,
        jobName: "order.calendar_imported",
      },
      {
        stream: "activity",
        category: "flow",
        action: "order.sla.recalculate",
        summary: "日历修正后重算业务时限",
        target: { type, id },
        entityId,
        storeId,
        before: { dueAt: before.toISOString() },
        after: { dueAt: after.toISOString(), calendarVersion },
        fields: ["dueAt", "calendarVersion"],
      },
    );
  for (const candidate of requests) {
    const row = await tx.cancelRequest.findUniqueOrThrow({
        where: { id: candidate.id },
        include: { approvalRequest: true },
      }),
      s = snapshot.safeParse(row.slaSnapshot),
      from = row.approvalRequest.decidedAt;
    if (
      row.status !== "pending_execution" ||
      row.executedAt ||
      row.closedAt ||
      !row.execDueAt ||
      !from ||
      row.approvalRequest.status !== "approved" ||
      !s.success ||
      !(await changed(tx, s.data, from, row.execDueAt, calendarVersion))
    )
      continue;
    const due = await deps.sla.dueAt(tx, {
      ...s.data,
      from,
      workHours: await workHoursAt(tx, from),
    });
    const subject = { type: "approval_request", id: row.approvalRequestId },
      key = `sla.breach:approval_request:${subject.id}:execution`;
    await deps.timers.cancel(tx, { subject, kinds: ["sla.breach"], keyPrefix: key });
    await tx.cancelRequest.update({
      where: { id: row.id },
      data: { execDueAt: due.dueAt, slaSnapshot: { ...due.snapshot }, updatedAt: deps.clock.now() },
    });
    await deps.timers.arm(tx, {
      kind: "sla.breach",
      subject,
      key,
      fireAt: due.dueAt,
      entityId: row.entityId,
      storeId: row.storeId,
      payload: { purpose: "execution", dueAt: due.dueAt.toISOString() },
    });
    await audit("cancel_request", row.id, row.entityId, row.storeId, row.execDueAt, due.dueAt);
  }
  for (const candidate of ads) {
    const row = await tx.ad.findUniqueOrThrow({ where: { id: candidate.id } }),
      s = snapshot.safeParse(row.slaSnapshot);
    if (
      !["pending_assign", "producing", "revising"].includes(row.status) ||
      row.openCancelRequestId ||
      !row.dueAt ||
      !s.success
    )
      continue;
    const revision =
      row.status === "revising"
        ? await tx.adRevision.findFirst({
            where: { adId: row.id, fulfilledByVersionNo: null },
            orderBy: { revisionNo: "desc" },
          })
        : null;
    if (row.status === "revising" && !revision) continue;
    const resumed =
      row.resubmitCount > 0 && !revision
        ? await tx.statusTransition.findFirst({
            where: { machine: "ad", subjectId: row.id, event: "ad.resubmit" },
            orderBy: { seq: "desc" },
          })
        : null;
    const from = revision?.createdAt ?? resumed?.occurredAt ?? row.submittedAt;
    if (!(await changed(tx, s.data, from, row.dueAt, calendarVersion))) continue;
    const due = await deps.sla.dueAt(tx, {
      ...s.data,
      from,
      workHours: await workHoursAt(tx, from),
    });
    const subject = { type: "ad", id: row.id },
      purpose = revision ? "rev" : "first",
      key = `sla.breach:ad:${row.id}:${purpose}:${revision?.revisionNo ?? row.resubmitCount}`;
    await deps.timers.cancel(tx, {
      subject,
      kinds: ["sla.breach"],
      keyPrefix: `sla.breach:ad:${row.id}:${purpose}:`,
    });
    await tx.ad.update({
      where: { id: row.id },
      data: {
        dueAt: due.dueAt,
        slaSnapshot: { ...due.snapshot },
        updatedAt: deps.clock.now(),
        ...(!revision && row.latestVersionNo === 0 ? { firstDueAt: due.dueAt } : {}),
      },
    });
    if (revision) {
      const outstanding = await tx.adRevision.findMany({
        where: { adId: row.id, fulfilledByVersionNo: null },
        orderBy: { id: "asc" },
      });
      for (const r of outstanding) {
        if (!(await changed(tx, s.data, r.createdAt, r.dueAt, calendarVersion))) continue;
        const revised = await deps.sla.dueAt(tx, {
          ...s.data,
          from: r.createdAt,
          workHours: await workHoursAt(tx, r.createdAt),
        });
        await tx.adRevision.update({
          where: { id: r.id },
          data: { dueAt: revised.dueAt, updatedAt: deps.clock.now() },
        });
      }
    }
    const breached = revision ? revision.breachedAt : row.firstBreachedAt;
    if (!breached)
      await deps.timers.arm(tx, {
        kind: "sla.breach",
        subject,
        key,
        fireAt: due.dueAt,
        entityId: row.entityId,
        storeId: row.storeId,
        payload: {
          purpose: revision ? "revision" : "first",
          ...(revision
            ? { revisionNo: revision.revisionNo }
            : { resubmitCount: row.resubmitCount }),
          dueAt: due.dueAt.toISOString(),
        },
      });
    await audit("ad", row.id, row.entityId, row.storeId, row.dueAt, due.dueAt);
  }
}
