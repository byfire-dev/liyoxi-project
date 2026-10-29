import { z } from "@liyoxi/contract";
import { DELIVERY_TICKET_STAGE_STEP } from "@liyoxi/contract/enums";
import { createIdentityContext } from "../kernel/index.js";
import type { FiredTimer, TimerOutcome, Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import { createTimers } from "../timers/index.js";
import { paramsAt } from "../config/index.js";
import { workHoursAt } from "../sla/index.js";
import { Prisma } from "@liyoxi/db";
import { AppError } from "../kernel/index.js";
import type { IdentityContext } from "../kernel/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { lockTickets } from "./repo.js";
import { checked } from "./transition-args.js";
import { calendarDate } from "@liyoxi/shared/time";
import { currentCalendarVersion, lockCalendarImport } from "../sla/index.js";

const policies = {
  assigning: "sla.ticket.assign",
  plan_confirm: "sla.ticket.plan_confirm",
  sample_making: "sla.ticket.sample_making",
  batch_compose: "sla.ticket.batch_compose",
  delivering: "sla.ticket.delivering",
} as const;

/** Ticket180 protects all stage visits. Replacing the timer invalidates dispatched old versions. */
export async function syncDeliveryStageSla(
  tx: Tx,
  deps: DeliveryCoreDeps,
  id: string,
  options: { recalculate?: boolean; from?: Date } = {},
) {
  const ticket = await tx.deliveryTicket.findUniqueOrThrow({ where: { id } });
  const stages = await tx.deliveryTicketStage.findMany({
    where: { deliveryTicketId: id },
    orderBy: { id: "asc" },
  });
  const timers = createTimers({ assembly: deps.assembly });
  for (const stage of stages.filter((s) => s.completedAt !== null))
    await timers.cancel(tx, {
      subject: { type: "delivery_ticket_stage", id: stage.id },
      kinds: ["sla.breach"],
    });
  const stage = stages.find((s) => s.completedAt === null);
  if (!stage) return;
  if (stage.step !== ticket.step)
    throw new AppError("INTERNAL", { message: "当前环节与工单不一致" });
  const policyKey = policies[ticket.step as keyof typeof policies];
  const waitingMerchant =
    ["sample_confirm", "awaiting_launch", "launch_verify"].includes(ticket.step) ||
    (ticket.step === "plan_confirm" && ticket.waitingOn === "merchant");
  const existing = stage.slaSnapshot === null ? null : readStageSlaSnapshot(stage.slaSnapshot);
  let from = options.from ?? stage.enteredAt;
  if (!options.from && ticket.step === "plan_confirm" && ticket.waitingOn === "staff") {
    const plan = await tx.deliveryPlan.findUnique({
      where: { dramaOrderId: ticket.dramaOrderId },
      select: { id: true },
    });
    const request = plan
      ? await tx.statusTransition.findFirst({
          where: {
            machine: "delivery_plan",
            subjectId: plan.id,
            event: "plan.request_change",
            occurredAt: { gte: stage.enteredAt },
          },
          orderBy: { seq: "desc" },
        })
      : null;
    if (request) from = request.occurredAt;
  }
  if (ticket.pauseCount > 0) {
    await timers.cancel(tx, {
      subject: { type: "delivery_ticket_stage", id: stage.id },
      kinds: ["sla.breach"],
    });
    return;
  }
  let dueAt: Date | null = null,
    slaSnapshot = null as ReturnType<typeof readStageSlaSnapshot> | null;
  if (policyKey && !waitingMerchant) {
    const policy = existing ?? (await paramsAt(tx, [policyKey], deps.clock.now()))[policyKey];
    const result = await deps.sla.dueAt(tx, {
      policy: existing?.policy ?? policyKey.slice(4),
      amount: policy.amount,
      unit: policy.unit,
      from,
      workHours: await workHoursAt(tx, from),
    });
    dueAt = result.dueAt;
    // Pauses already consumed in this visit remain credited when the calendar changes.
    let creditedPauseMinutes = stage.pausedMinutes;
    if (from > stage.enteredAt && creditedPauseMinutes > 0) {
      const pauses = await tx.deliveryTicketPause.findMany({
        where: { deliveryTicketId: id, releasedAt: { gt: from } },
        orderBy: { createdAt: "asc" },
      });
      const intervals: Array<{ start: Date; end: Date }> = [];
      for (const pause of pauses) {
        if (!pause.releasedAt) continue;
        const start = pause.createdAt > from ? pause.createdAt : from,
          end = pause.releasedAt;
        const prior = intervals.at(-1);
        if (prior && start <= prior.end) {
          if (end > prior.end) prior.end = end;
        } else intervals.push({ start, end });
      }
      creditedPauseMinutes = 0;
      for (const interval of intervals)
        creditedPauseMinutes += await deps.sla.workMinutesBetween(tx, {
          from: interval.start,
          to: interval.end,
          workHours: await workHoursAt(tx, interval.start),
        });
    }
    if (creditedPauseMinutes > 0)
      dueAt = (
        await deps.sla.dueAt(tx, {
          policy: result.snapshot.policy,
          amount: creditedPauseMinutes,
          unit: "work_minutes",
          from: dueAt,
          workHours: await workHoursAt(tx, dueAt),
        })
      ).dueAt;
    slaSnapshot = result.snapshot;
  }
  if (
    stage.dueAt?.getTime() === dueAt?.getTime() &&
    JSON.stringify(existing) === JSON.stringify(slaSnapshot) &&
    !options.recalculate
  )
    return;
  await tx.deliveryTicketStage.update({
    where: { id: stage.id },
    data: {
      dueAt,
      slaSnapshot: slaSnapshot ?? Prisma.DbNull,
      updatedAt: deps.clock.now(),
    },
  });
  await tx.deliveryTicket.update({
    where: { id },
    data: { stepDueAt: dueAt, updatedAt: deps.clock.now() },
  });
  if (ticket.step === "plan_confirm")
    await tx.deliveryPlan.updateMany({
      where: { dramaOrderId: ticket.dramaOrderId },
      data: { staffDueAt: dueAt, updatedAt: deps.clock.now() },
    });
  const subject = { type: "delivery_ticket_stage", id: stage.id };
  await timers.cancel(tx, { subject, kinds: ["sla.breach"] });
  if (dueAt && slaSnapshot && !stage.isBreached)
    await timers.arm(tx, {
      kind: "sla.breach",
      subject,
      key: timerKey("sla.breach", subject),
      fireAt: dueAt,
      entityId: ticket.entityId,
      storeId: ticket.storeId,
      payload: { ...slaSnapshot, dueAt: dueAt.toISOString() },
    });
}

export async function onDeliveryCalendarImported(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  calendarVersion: number,
) {
  await lockCalendarImport(tx);
  if (calendarVersion !== (await currentCalendarVersion(tx))) return;
  const rows = await tx.deliveryTicket.findMany({
    where: { step: { notIn: ["archived", "terminated"] } },
    orderBy: { id: "asc" },
  });
  await lockTickets(
    tx,
    rows.map((t) => t.id),
  );
  for (const t of rows) {
    const stage = await tx.deliveryTicketStage.findFirst({
      where: { deliveryTicketId: t.id, completedAt: null },
    });
    if (!stage?.slaSnapshot || !stage.dueAt || t.pauseCount) continue;
    const before = readStageSlaSnapshot(stage.slaSnapshot);
    if (
      before.calendarVersion >= calendarVersion ||
      !["work_days", "work_minutes"].includes(before.unit)
    )
      continue;
    const changed = await tx.workCalendarDay.count({
      where: {
        day: {
          gte: new Date(calendarDate(stage.enteredAt)),
          lte: new Date(calendarDate(stage.dueAt)),
        },
        calendarVersion: { gt: before.calendarVersion, lte: calendarVersion },
      },
    });
    if (!changed) continue;
    await syncDeliveryStageSla(tx, deps, t.id, { recalculate: true });
    const after = await tx.deliveryTicketStage.findUniqueOrThrow({ where: { id: stage.id } });
    await deps.flow.transition(tx, ctx, {
      machine: "delivery_ticket",
      stateField: "step",
      id: t.id,
      event: "sla.recalculated",
      to: t.step,
      args: checked(),
      entityId: t.entityId,
      storeId: t.storeId,
      payload: {
        calendarVersion,
        dueAtBefore: stage.dueAt.toISOString(),
        dueAtAfter: after.dueAt?.toISOString() ?? null,
      },
      audit: {
        stream: "activity",
        category: "delivery",
        action: "delivery.ticket.recalculate",
        summary: "日历修正后重算交付环节时限",
        target: { type: "delivery_ticket", id: t.id },
        entityId: t.entityId,
        storeId: t.storeId,
        before: { dueAt: stage.dueAt.toISOString(), slaSnapshot: before },
        after: { dueAt: after.dueAt?.toISOString() ?? null, slaSnapshot: after.slaSnapshot },
        fields: ["dueAt", "slaSnapshot"],
      },
      emit: { none: true, primary: "calendar.imported" },
    });
  }
}

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
      step: z.enum(DELIVERY_TICKET_STAGE_STEP.values).parse(stage.step),
      dueAt: stage.dueAt.toISOString(),
    },
  });
  return "fired";
}
