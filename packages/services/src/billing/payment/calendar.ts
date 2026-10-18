// W4-04：同一 billing.onCalendarImported 后续可组合发票/退款所属分支，不重复登记。
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { lockRows, createIdentityContext } from "../../kernel/index.js";
import type { Tx, DeliveredEvent } from "../../kernel/index.js";
import { record } from "../../audit/index.js";
import { currentCalendarVersion, lockCalendarImport, workHoursAt } from "../../sla/index.js";
import { armTransferSla, cancelTransferSla, readTransferSla } from "./transfer-sla.js";
import type { TransferSlaDeps } from "./transfer-sla.js";

export async function onTransferCalendarImported(
  tx: Tx,
  deps: TransferSlaDeps,
  event: DeliveredEvent,
  candidateIds?: readonly string[],
) {
  if (event.type !== "calendar.imported") return;
  const payload = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload);
  await lockCalendarImport(tx);
  if (payload.calendarVersion !== (await currentCalendarVersion(tx))) return;
  const candidates = await tx.transferProof.findMany({
    where: {
      reviewStatus: "pending",
      dueAt: { not: null },
      ...(candidateIds ? { id: { in: [...candidateIds] } } : {}),
    },
    select: { id: true, billingOrderId: true },
    orderBy: { id: "asc" },
  });
  // 批量预锁全部付款单，随后全部凭证；不能在已取得310后转回另一个290。
  await lockRows(tx, "billing_order", [...new Set(candidates.map((p) => p.billingOrderId))]);
  await lockRows(
    tx,
    "transfer_proof",
    candidates.map((p) => p.id),
  );
  for (const candidate of candidates) {
    const proof = await tx.transferProof.findUniqueOrThrow({ where: { id: candidate.id } });
    const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: proof.billingOrderId } });
    const snapshot = readTransferSla(proof.slaSnapshot);
    if (
      proof.reviewStatus !== "pending" ||
      proof.dueAt === null ||
      snapshot === null ||
      order.status !== "pending_confirmation" ||
      !["proof_submitted", "confirm_review"].includes(order.transferState ?? "") ||
      snapshot.calendarVersion >= payload.calendarVersion ||
      !["work_days", "work_minutes", "same_day_cutoff"].includes(snapshot.unit)
    )
      continue;
    const changed = await tx.workCalendarDay.count({
      where: {
        day: {
          gte: new Date(`${calendarDate(proof.uploadedAt)}T00:00:00Z`),
          lte: new Date(`${calendarDate(proof.dueAt)}T00:00:00Z`),
        },
        calendarVersion: { gt: snapshot.calendarVersion, lte: payload.calendarVersion },
      },
    });
    if (!changed) continue;
    const due = await deps.sla.dueAt(tx, {
      policy: snapshot.policy,
      amount: snapshot.amount,
      unit: snapshot.unit,
      from: proof.uploadedAt,
      workHours: await workHoursAt(tx, proof.uploadedAt),
    });
    await cancelTransferSla(tx, deps.timers, proof.id);
    const updated = await tx.transferProof.update({
      where: { id: proof.id },
      data: {
        dueAt: due.dueAt,
        slaSnapshot: { ...due.snapshot },
        updatedAt: deps.clock.now(),
      },
    });
    await armTransferSla(tx, deps, updated);
    const ctx = createIdentityContext({
      actor: { type: "system", job: "billing.calendar_imported" },
      entityId: proof.entityId,
      storeId: order.storeId,
    });
    await record(
      tx,
      ctx.actor,
      { requestId: null, ip: null, userAgent: null, authMethod: null, sessionId: null },
      {
        stream: "ops",
        category: "payment",
        action: "billing.transfer_proof.recalculate",
        summary: "日历修正后重算对公凭证处理时限",
        target: { type: "transfer_proof", id: proof.id },
        entityId: proof.entityId,
        storeId: order.storeId,
        before: { dueAt: proof.dueAt.toISOString(), slaSnapshot: snapshot },
        after: { dueAt: due.dueAt.toISOString(), slaSnapshot: due.snapshot },
        fields: ["dueAt", "slaSnapshot"],
      },
    );
  }
}
