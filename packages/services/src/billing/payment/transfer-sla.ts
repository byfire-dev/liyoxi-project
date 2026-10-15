// W4-04：对公凭证只计处理时限；二人复核不是另一个决定时限。
import { z } from "zod";
import type { TransferProof } from "@liyoxi/db";
import { InstantSchema } from "@liyoxi/contract";
import { createIdentityContext, lockRows } from "../../kernel/index.js";
import type { Clock, FiredTimer, Tx, TimerOutcome } from "../../kernel/index.js";
import type { Events } from "../../events/index.js";
import type { Sla } from "../../sla/index.js";
import { timerKey } from "../../timers/index.js";
import type { Timers } from "../../timers/index.js";

const snapshotSchema = z.strictObject({
  policy: z.literal("review.transfer_proof"),
  amount: z.int().nonnegative(),
  unit: z.enum(["work_minutes", "work_days", "natural_hours", "natural_days", "same_day_cutoff"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: InstantSchema,
});
export function readTransferSla(value: unknown) {
  const parsed = snapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export interface TransferSlaDeps {
  clock: Clock;
  events: Pick<Events, "emit">;
  timers: Pick<Timers, "arm" | "cancel">;
  sla: Pick<Sla, "dueAt">;
}
const prefix = (id: string) => timerKey("sla.breach", { type: "transfer_proof", id });
export const transferSlaKey = (id: string, calendarVersion: number) =>
  timerKey("sla.breach", { type: "transfer_proof", id }, calendarVersion);
export function cancelTransferSla(tx: Tx, timers: TransferSlaDeps["timers"], id: string) {
  return timers.cancel(tx, {
    subject: { type: "transfer_proof", id },
    kinds: ["sla.breach"],
    keyPrefix: prefix(id),
  });
}
export async function armTransferSla(tx: Tx, deps: TransferSlaDeps, proof: TransferProof) {
  const snapshot = readTransferSla(proof.slaSnapshot);
  if (proof.reviewStatus !== "pending" || proof.dueAt === null || snapshot === null) return;
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: proof.billingOrderId } });
  await deps.timers.arm(tx, {
    kind: "sla.breach",
    subject: { type: "transfer_proof", id: proof.id },
    key: transferSlaKey(proof.id, snapshot.calendarVersion),
    fireAt: proof.dueAt,
    payload: { ...snapshot, dueAt: proof.dueAt.toISOString() },
    entityId: proof.entityId,
    ...(order.storeId === null ? {} : { storeId: order.storeId }),
  });
}
export async function handleTransferSla(
  tx: Tx,
  deps: TransferSlaDeps,
  timer: FiredTimer,
): Promise<TimerOutcome> {
  if (timer.subjectType !== "transfer_proof" || timer.subjectId === null) return "skipped";
  const candidate = await tx.transferProof.findUnique({ where: { id: timer.subjectId } });
  if (!candidate) return "skipped";
  await lockRows(tx, "billing_order", [candidate.billingOrderId]);
  await lockRows(tx, "transfer_proof", [candidate.id]);
  const proof = await tx.transferProof.findUniqueOrThrow({ where: { id: candidate.id } });
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: proof.billingOrderId } });
  const persisted = await tx.timer.findUnique({ where: { id: timer.id } });
  const snapshot = readTransferSla(proof.slaSnapshot);
  if (
    proof.reviewStatus !== "pending" ||
    order.status !== "pending_confirmation" ||
    !["proof_submitted", "confirm_review"].includes(order.transferState ?? "") ||
    proof.dueAt === null ||
    snapshot === null ||
    !persisted ||
    persisted.status !== "dispatched" ||
    proof.dueAt > deps.clock.now() ||
    persisted.dedupeKey !== transferSlaKey(proof.id, snapshot.calendarVersion) ||
    persisted.fireAt.getTime() !== proof.dueAt.getTime() ||
    timer.payload?.dueAt !== proof.dueAt.toISOString()
  )
    return "skipped";
  const ctx = createIdentityContext({
    actor: { type: "system", job: "billing.transfer_sla" },
    entityId: proof.entityId,
    storeId: order.storeId,
  });
  await deps.events.emit(tx, ctx, {
    type: "transfer.sla_breached",
    aggregate: { type: "transfer_proof", id: proof.id },
    payload: {
      v: 1,
      transferProofId: proof.id,
      billingOrderId: order.id,
      entityId: proof.entityId,
      dueAt: proof.dueAt.toISOString(),
    },
    entityId: proof.entityId,
    storeId: order.storeId,
    dedupeKey: `tmr:${persisted.dedupeKey}`,
  });
  return "fired";
}

export async function armTransferTtl(
  tx: Tx,
  deps: Pick<TransferSlaDeps, "timers">,
  o: { id: string; entityId: string; storeId: string | null; expiresAt: Date },
) {
  await deps.timers.arm(tx, {
    kind: "po.transfer_ttl",
    subject: { type: "billing_order", id: o.id },
    fireAt: o.expiresAt,
    key: `po.transfer_ttl:billing_order:${o.id}:${o.expiresAt.getTime()}`,
    entityId: o.entityId,
    ...(o.storeId ? { storeId: o.storeId } : {}),
    payload: { expiresAt: o.expiresAt.toISOString() },
  });
}
