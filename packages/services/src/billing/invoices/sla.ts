import { z } from "zod";
import { EVENT_PAYLOAD_SCHEMAS, InstantSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import type { InvoiceRequest } from "@liyoxi/db";
import { createIdentityContext, lockRows } from "../../kernel/index.js";
import type { Tx, FiredTimer, TimerOutcome, DeliveredEvent } from "../../kernel/index.js";
import { timerKey } from "../../timers/index.js";
import { currentCalendarVersion, lockCalendarImport, workHoursAt } from "../../sla/index.js";
import type { InvoiceRuntimeDeps } from "./context.js";
const Snapshot = z.strictObject({
  policy: z.literal("review.invoice_request"),
  amount: z.int().nonnegative(),
  unit: z.enum(["work_minutes", "work_days", "natural_hours", "natural_days", "same_day_cutoff"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: InstantSchema,
});
export function readInvoiceSla(value: unknown) {
  const parsed = Snapshot.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const prefix = (id: string) => timerKey("sla.breach", { type: "invoice_request", id });
export const invoiceSlaKey = (id: string, version: number) =>
  timerKey("sla.breach", { type: "invoice_request", id }, version);
export const cancelInvoiceSla = (tx: Tx, timers: InvoiceRuntimeDeps["timers"], id: string) =>
  timers.cancel(tx, {
    subject: { type: "invoice_request", id },
    kinds: ["sla.breach"],
    keyPrefix: prefix(id),
  });
export async function armInvoiceSla(tx: Tx, deps: InvoiceRuntimeDeps, row: InvoiceRequest) {
  const s = readInvoiceSla(row.slaSnapshot);
  if (row.status !== "pending" || !row.dueAt || !s) return;
  await deps.timers.arm(tx, {
    kind: "sla.breach",
    subject: { type: "invoice_request", id: row.id },
    key: invoiceSlaKey(row.id, s.calendarVersion),
    fireAt: row.dueAt,
    payload: { ...s, dueAt: row.dueAt.toISOString() },
    entityId: row.entityId,
  });
}
export async function handleInvoiceSla(
  tx: Tx,
  deps: InvoiceRuntimeDeps,
  timer: FiredTimer,
): Promise<TimerOutcome> {
  if (timer.subjectType !== "invoice_request" || !timer.subjectId) return "skipped";
  const candidate = await tx.invoiceRequest.findUnique({ where: { id: timer.subjectId } });
  if (!candidate) return "skipped";
  await lockRows(tx, "billing_order", [candidate.billingOrderId]);
  await lockRows(tx, "invoice_request", [candidate.id]);
  const row = await tx.invoiceRequest.findUniqueOrThrow({ where: { id: candidate.id } }),
    s = readInvoiceSla(row.slaSnapshot),
    persisted = await tx.timer.findUnique({ where: { id: timer.id } });
  if (
    row.status !== "pending" ||
    !row.dueAt ||
    !s ||
    row.dueAt > deps.clock.now() ||
    !persisted ||
    persisted.status !== "dispatched" ||
    persisted.dedupeKey !== invoiceSlaKey(row.id, s.calendarVersion) ||
    persisted.fireAt.getTime() !== row.dueAt.getTime() ||
    timer.payload?.dueAt !== row.dueAt.toISOString()
  )
    return "skipped";
  const ctx = createIdentityContext({
    actor: { type: "system", job: "billing.invoice_sla" },
    entityId: row.entityId,
  });
  await deps.events.emit(tx, ctx, {
    type: "invoice.sla_breached",
    aggregate: { type: "invoice_request", id: row.id },
    payload: { v: 1, invoiceRequestId: row.id, dueAt: row.dueAt.toISOString() },
    entityId: row.entityId,
    dedupeKey: `tmr:${persisted.dedupeKey}`,
  });
  return "fired";
}
/** Before the existing transfer branch takes rank310, pre-lock the union of both order sets. */
export async function lockBillingCalendarOrders(tx: Tx, event: DeliveredEvent) {
  if (event.type !== "calendar.imported") return null;
  await lockCalendarImport(tx);
  const [proofs, invoices] = await Promise.all([
    tx.transferProof.findMany({
      where: { reviewStatus: "pending", dueAt: { not: null } },
      select: { id: true, billingOrderId: true },
    }),
    tx.invoiceRequest.findMany({
      where: { status: "pending", dueAt: { not: null } },
      select: { id: true, billingOrderId: true },
    }),
  ]);
  await lockRows(tx, "billing_order", [
    ...new Set([...proofs, ...invoices].map((r) => r.billingOrderId)),
  ]);
  return { proofIds: proofs.map((r) => r.id), invoiceIds: invoices.map((r) => r.id) };
}
export async function onInvoiceCalendarImported(
  tx: Tx,
  deps: InvoiceRuntimeDeps,
  event: DeliveredEvent,
  candidateIds?: readonly string[],
) {
  if (event.type !== "calendar.imported") return;
  const payload = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload);
  await lockCalendarImport(tx);
  if (payload.calendarVersion !== (await currentCalendarVersion(tx))) return;
  const candidates = await tx.invoiceRequest.findMany({
    where: {
      status: "pending",
      dueAt: { not: null },
      ...(candidateIds ? { id: { in: [...candidateIds] } } : {}),
    },
    orderBy: { id: "asc" },
  });
  await lockRows(tx, "billing_order", [...new Set(candidates.map((r) => r.billingOrderId))]);
  await lockRows(
    tx,
    "invoice_request",
    candidates.map((r) => r.id),
  );
  for (const c of candidates) {
    const row = await tx.invoiceRequest.findUniqueOrThrow({ where: { id: c.id } }),
      s = readInvoiceSla(row.slaSnapshot);
    if (
      row.status !== "pending" ||
      !row.dueAt ||
      !s ||
      s.calendarVersion >= payload.calendarVersion ||
      !["work_days", "work_minutes", "same_day_cutoff"].includes(s.unit)
    )
      continue;
    const changed = await tx.workCalendarDay.count({
      where: {
        day: {
          gte: new Date(`${calendarDate(row.appliedAt)}T00:00:00Z`),
          lte: new Date(`${calendarDate(row.dueAt)}T00:00:00Z`),
        },
        calendarVersion: { gt: s.calendarVersion, lte: payload.calendarVersion },
      },
    });
    if (!changed) continue;
    const due = await deps.sla.dueAt(tx, {
      policy: s.policy,
      amount: s.amount,
      unit: s.unit,
      from: row.appliedAt,
      workHours: await workHoursAt(tx, row.appliedAt),
    });
    await cancelInvoiceSla(tx, deps.timers, row.id);
    const ctx = createIdentityContext({
      actor: { type: "system", job: "billing.calendar_imported" },
      entityId: row.entityId,
    });
    await deps.flow.transition(tx, ctx, {
      machine: "invoice_request",
      stateField: "status",
      id: row.id,
      event: "sla.recalculated",
      ref: "08:1133",
      args: { calendarValidated: true },
      set: { due_at: due.dueAt, sla_snapshot: { ...due.snapshot } },
      payload: { calendarVersion: due.snapshot.calendarVersion },
      audit: {
        stream: "ops",
        category: "invoice",
        action: "billing.invoice.recalculate",
        summary: "日历修正后重算开票处理时限",
        target: { type: "invoice_request", id: row.id },
        entityId: row.entityId,
        before: { dueAt: row.dueAt.toISOString() },
        after: { dueAt: due.dueAt.toISOString() },
        fields: ["dueAt", "slaSnapshot"],
      },
      emit: { none: true, primary: "calendar.imported" },
    });
    await armInvoiceSla(
      tx,
      deps,
      await tx.invoiceRequest.findUniqueOrThrow({ where: { id: row.id } }),
    );
  }
}
