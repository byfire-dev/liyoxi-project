import { Prisma } from "@liyoxi/db";
import { z } from "@liyoxi/contract";
import { actorColumns, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { pauseCollectionChecked } from "./machines.js";
import { readStageSlaSnapshot } from "./stage-sla.js";

export async function pauseSourceValid(
  tx: Tx,
  row: { reason: string; refType: string; refId: string; deliveryTicketId: string },
) {
  const ticket = await tx.deliveryTicket.findUnique({ where: { id: row.deliveryTicketId } });
  if (!ticket || ["archived", "terminated", "in_service", "takedown"].includes(ticket.step))
    return false;
  if (row.reason === "cancel_review" && row.refType === "approval_request") {
    const request = await tx.cancelRequest.findUnique({
      where: { approvalRequestId: row.refId },
      include: { cancelRequestLines: true },
    });
    return (
      !!request &&
      request.closedAt === null &&
      request.entityId === ticket.entityId &&
      request.storeId === ticket.storeId &&
      request.cancelRequestLines.some(
        (l) => l.targetType === "order_item" && l.targetId === ticket.orderItemId,
      )
    );
  }
  if (row.reason === "plan_amendment" && row.refType === "delivery_plan_version") {
    const version = await tx.deliveryPlanVersion.findUnique({
      where: { id: row.refId },
      include: { deliveryPlan: true },
    });
    return (
      !!version &&
      version.deliveryPlan.dramaOrderId === ticket.dramaOrderId &&
      version.versionNo === version.deliveryPlan.currentVersionNo &&
      ["pending_confirm", "revising"].includes(version.deliveryPlan.status)
    );
  }
  return false;
}

/** Caller owns ticket and every lower owner lock; sources are changed only inside this Tx. */
export async function holdPlanAmendment(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  id: string,
  versionId: string,
) {
  const t = await tx.deliveryTicket.findUniqueOrThrow({ where: { id } });
  if (["in_service", "takedown", "archived", "terminated"].includes(t.step)) return;
  if (
    await tx.deliveryTicketPause.findFirst({
      where: { deliveryTicketId: id, reason: "plan_amendment", refId: versionId, releasedAt: null },
    })
  )
    return;
  const now = deps.clock.now(),
    stage = await tx.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: id, completedAt: null },
    });
  const remaining = t.pauseCount
    ? t.pauseRemainingMin
    : stage.dueAt === null
      ? null
      : stage.dueAt <= now
        ? 0
        : await deps.sla.workMinutesBetween(tx, {
            from: now,
            to: stage.dueAt,
            workHours: await workHoursAt(tx, now),
          });
  await tx.deliveryTicketPause.create({
    data: {
      id: uuidv7(),
      deliveryTicketId: id,
      reason: "plan_amendment",
      refType: "delivery_plan_version",
      refId: versionId,
      ...actorColumns(ctx.actor),
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "delivery_ticket",
    stateField: "step",
    id,
    event: "ticket.hold",
    to: t.step,
    args: pauseCollectionChecked(),
    entityId: t.entityId,
    storeId: t.storeId,
    set: {
      pause_count: t.pauseCount + 1,
      ...(t.pauseCount ? {} : { paused_at: now, pause_remaining_min: remaining }),
    },
    emit: {
      type: "ticket.held",
      payload: {
        v: 1,
        deliveryTicketId: id,
        orderItemId: t.orderItemId,
        reason: "plan_amendment",
        refId: versionId,
      },
    },
  });
  await createTimers({ assembly: deps.assembly }).cancel(tx, {
    subject: { type: "delivery_ticket_stage", id: stage.id },
    kinds: ["sla.breach"],
  });
}
export async function releasePause(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  pauseId: string,
  releaseEvent: "plan_confirmed" | "superseded" | "self_heal",
) {
  const cause = await tx.deliveryTicketPause.findUniqueOrThrow({ where: { id: pauseId } });
  if (cause.releasedAt) return;
  const t = await tx.deliveryTicket.findUniqueOrThrow({ where: { id: cause.deliveryTicketId } }),
    now = deps.clock.now();
  const active = await tx.deliveryTicketPause.count({
    where: { deliveryTicketId: t.id, releasedAt: null },
  });
  const nextCount = active - 1,
    stage = await tx.deliveryTicketStage.findFirst({
      where: { deliveryTicketId: t.id, completedAt: null },
    });
  let dueAt = t.stepDueAt;
  if (nextCount === 0 && stage) {
    const original = stage.slaSnapshot === null ? null : readStageSlaSnapshot(stage.slaSnapshot);
    let nextSnapshot = original;
    if (original && t.pauseRemainingMin !== null) {
      const result = await deps.sla.dueAt(tx, {
        policy: original.policy,
        amount: t.pauseRemainingMin,
        unit: "work_minutes",
        from: now,
        workHours: await workHoursAt(tx, now),
      });
      dueAt = t.pauseRemainingMin === 0 ? now : result.dueAt;
      nextSnapshot = {
        ...original,
        calendarVersion: result.snapshot.calendarVersion,
        computedAt: result.snapshot.computedAt,
      };
    }
    const pausedMinutes = t.pausedAt
      ? await deps.sla.workMinutesBetween(tx, {
          from: t.pausedAt,
          to: now,
          workHours: await workHoursAt(tx, now),
        })
      : 0;
    await tx.deliveryTicketStage.update({
      where: { id: stage.id },
      data: {
        dueAt,
        slaSnapshot: nextSnapshot ?? Prisma.DbNull,
        pausedMinutes: { increment: pausedMinutes },
        updatedAt: now,
      },
    });
    if (t.step === "plan_confirm")
      await tx.deliveryPlan.updateMany({
        where: { dramaOrderId: t.dramaOrderId },
        data: { staffDueAt: t.waitingOn === "staff" ? dueAt : null, updatedAt: now },
      });
    const timers = createTimers({ assembly: deps.assembly }),
      subject = { type: "delivery_ticket_stage", id: stage.id };
    await timers.cancel(tx, { subject, kinds: ["sla.breach"] });
    if (dueAt && nextSnapshot && !stage.isBreached)
      await timers.arm(tx, {
        kind: "sla.breach",
        subject,
        key: timerKey("sla.breach", subject),
        fireAt: dueAt,
        entityId: t.entityId,
        storeId: t.storeId,
        payload: { ...nextSnapshot, dueAt: dueAt.toISOString() },
      });
  }
  await deps.flow.transition(tx, ctx, {
    machine: "delivery_ticket",
    stateField: "step",
    id: t.id,
    event: "ticket.resume",
    to: t.step,
    args: pauseCollectionChecked(),
    entityId: t.entityId,
    storeId: t.storeId,
    set: {
      pause_count: nextCount,
      ...(nextCount ? {} : { paused_at: null, pause_remaining_min: null, step_due_at: dueAt }),
    },
    emit: {
      type: "ticket.resumed",
      payload: {
        v: 1,
        deliveryTicketId: t.id,
        orderItemId: t.orderItemId,
        reason: z.enum(["cancel_review", "plan_amendment"]).parse(cause.reason),
        refId: cause.refId,
      },
    },
  });
  await tx.deliveryTicketPause.update({
    where: { id: cause.id },
    data: { releasedAt: now, releaseEvent, updatedAt: now },
  });
}
