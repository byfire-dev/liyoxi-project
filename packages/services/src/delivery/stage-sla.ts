import { z } from "@liyoxi/contract";
import { createIdentityContext } from "../kernel/index.js";
import type { FiredTimer, TimerOutcome, Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { lockTickets } from "./repo.js";

const snapshot = z.strictObject({
  policy: z.string().min(1),
  amount: z.number().nonnegative(),
  unit: z.enum(["work_minutes", "work_days", "natural_hours", "natural_days", "same_day_cutoff"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: z.iso.datetime(),
});
export const readStageSlaSnapshot = (value: unknown) => snapshot.parse(value);
export type DeliveryStageSlaDeps = Pick<DeliveryCoreDeps, "clock" | "events">;

/** The parent ticket protects this unranked stage; stale deliveries cannot breach a new deadline. */
export async function handleDeliveryStageSlaBreach(
  tx: Tx,
  deps: DeliveryStageSlaDeps,
  timer: FiredTimer,
): Promise<TimerOutcome> {
  if (
    timer.kind !== "sla.breach" ||
    timer.subjectType !== "delivery_ticket_stage" ||
    !timer.subjectId
  )
    return "skipped";
  const first = await tx.deliveryTicketStage.findUnique({ where: { id: timer.subjectId } });
  if (!first) return "skipped";
  await lockTickets(tx, [first.deliveryTicketId]);
  const stage = await tx.deliveryTicketStage.findUnique({ where: { id: first.id } });
  const ticket = await tx.deliveryTicket.findUnique({ where: { id: first.deliveryTicketId } });
  const persisted = await tx.timer.findUnique({ where: { id: timer.id } });
  const now = deps.clock.now();
  if (
    !stage ||
    !ticket ||
    stage.completedAt ||
    stage.isBreached ||
    !stage.dueAt ||
    ticket.pauseCount > 0 ||
    ticket.step !== stage.step ||
    ticket.stepDueAt?.getTime() !== stage.dueAt.getTime() ||
    !persisted ||
    persisted.status !== "dispatched" ||
    persisted.kind !== "sla.breach" ||
    persisted.subjectType !== "delivery_ticket_stage" ||
    persisted.subjectId !== stage.id ||
    persisted.dedupeKey !==
      timerKey("sla.breach", { type: "delivery_ticket_stage", id: stage.id }) ||
    persisted.fireAt.getTime() !== stage.dueAt.getTime() ||
    stage.dueAt > now ||
    timer.payload?.dueAt !== stage.dueAt.toISOString()
  )
    return "skipped";
  const current = readStageSlaSnapshot(stage.slaSnapshot);
  if (Object.entries(current).some(([key, value]) => timer.payload?.[key] !== value))
    return "skipped";
  await tx.deliveryTicketStage.update({
    where: { id: stage.id },
    data: { isBreached: true, updatedAt: now },
  });
  const ctx = createIdentityContext({
    actor: { type: "system", job: "delivery.stage_sla_breach" },
  });
  await deps.events.emit(tx, ctx, {
    type: "ticket.sla_breached",
    aggregate: { type: "delivery_ticket", id: ticket.id },
    entityId: ticket.entityId,
    storeId: ticket.storeId,
    dedupeKey: `tmr:${persisted.dedupeKey}`,
    payload: {
      v: 1,
      deliveryTicketId: ticket.id,
      deliveryTicketStageId: stage.id,
      step: stage.step,
      dueAt: stage.dueAt.toISOString(),
    },
  });
  return "fired";
}
