import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { cancelResumeChecked } from "./machines.js";
import { reevaluate } from "./reevaluate.js";
import { prepareReevaluation, readReevaluationTargets } from "./reevaluate-locks.js";
import { readStageSlaSnapshot } from "./stage-sla.js";

export interface CancelReviewPauseTargets {
  readonly reevaluation: Awaited<ReturnType<typeof readReevaluationTargets>>;
  readonly approvalRequestIds: readonly string[];
  readonly dramaIds: readonly string[];
  readonly dramaOrderIds: readonly string[];
  readonly orderItemIds: readonly string[];
  readonly deliveryTicketIds: readonly string[];
  readonly deliveryTicketPauseIds: readonly string[];
  readonly deliveryPlanIds: readonly string[];
  readonly coverFileIds: readonly string[];
}
const ids = (values: readonly (string | null | undefined)[]) =>
  [...new Set(values.filter((v): v is string => !!v))].sort();

/** Read before the caller locks its complete, multi-owner graph. This does not acquire locks. */
export async function readCancelReviewPauseTargets(
  tx: Tx,
  approvalRequestIds: readonly string[],
): Promise<CancelReviewPauseTargets> {
  const tickets = await tx.deliveryTicket.findMany({
    where: {
      deliveryTicketPauses: {
        some: {
          reason: "cancel_review",
          refType: "approval_request",
          refId: { in: [...approvalRequestIds] },
          releasedAt: null,
        },
      },
    },
    select: {
      id: true,
      dramaId: true,
      dramaOrderId: true,
      orderItemId: true,
      drama: { select: { posterFileId: true } },
      orderItem: { select: { dramaSnapshot: true } },
      dramaOrder: { select: { deliveryPlan: { select: { id: true } } } },
      deliveryTicketPauses: {
        where: {
          reason: "cancel_review",
          refType: "approval_request",
          refId: { in: [...approvalRequestIds] },
          releasedAt: null,
        },
        select: { id: true },
      },
    },
  });
  return {
    reevaluation: await readReevaluationTargets(
      tx,
      tickets.map((t) => t.id),
    ),
    approvalRequestIds: ids(approvalRequestIds),
    dramaIds: ids(tickets.map((t) => t.dramaId)),
    dramaOrderIds: ids(tickets.map((t) => t.dramaOrderId)),
    orderItemIds: ids(tickets.map((t) => t.orderItemId)),
    deliveryTicketIds: ids(tickets.map((t) => t.id)),
    deliveryTicketPauseIds: ids(tickets.flatMap((t) => t.deliveryTicketPauses.map((p) => p.id))),
    deliveryPlanIds: ids(tickets.map((t) => t.dramaOrder.deliveryPlan?.id)),
    coverFileIds: ids(
      tickets.map(
        (t) =>
          (t.orderItem.dramaSnapshot as { posterFileId?: string }).posterFileId ??
          t.drama.posterFileId,
      ),
    ),
  };
}
function sameTargets(a: CancelReviewPauseTargets, b: CancelReviewPauseTargets) {
  return (Object.keys(a) as (keyof CancelReviewPauseTargets)[]).every(
    (key) => JSON.stringify(a[key]) === JSON.stringify(b[key]),
  );
}

/** Caller owns all lower-ranked locks and has prelocked the union of every owner's targets.
 * A changed graph fails atomically; this function never discovers and adds a late lower lock.
 */
export async function releaseCancelReviewPauses(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  input: {
    readonly targets: CancelReviewPauseTargets;
    readonly releaseEvent: "rejected" | "withdrawn" | "voided";
  },
) {
  const { targets, releaseEvent } = input;
  // The outer owner prelocks this full union before changing approvals or other owners.
  // On direct calls this also starts at the lowest required rank, before any own lock.
  await prepareReevaluation(tx, targets.deliveryTicketIds, {
    approvalRequestIds: targets.approvalRequestIds,
  });
  await lockRows(tx, "approval_request", targets.approvalRequestIds);
  const checkTargets = async () => {
    if (!sameTargets(targets, await readCancelReviewPauseTargets(tx, targets.approvalRequestIds)))
      throw new AppError("STATE_NOT_ALLOWED", { message: "取消暂停的锁图已变化，请重试整个事务" });
  };
  await checkTargets();
  for (const [table, values] of [
    ["drama", targets.dramaIds],
    ["drama_order", targets.dramaOrderIds],
    ["order_item", targets.orderItemIds],
    ["delivery_ticket", targets.deliveryTicketIds],
    ["delivery_plan", targets.deliveryPlanIds],
    ["file_object", targets.coverFileIds],
  ] as const)
    await lockRows(tx, table, values, table === "drama" ? "share" : "update");
  await checkTargets();
  const timers = createTimers({ assembly: deps.assembly });
  const resumedTicketIds: string[] = [];
  let released = 0;
  for (const id of targets.deliveryTicketIds) {
    const t = await tx.deliveryTicket.findUniqueOrThrow({ where: { id } });
    const active = await tx.deliveryTicketPause.findMany({
      where: { deliveryTicketId: id, releasedAt: null },
      orderBy: { id: "asc" },
    });
    if (active.length !== t.pauseCount || !t.pausedAt)
      throw new AppError("INTERNAL", { message: "工单暂停集合与汇总不一致" });
    const own = active.filter(
      (p) =>
        p.reason === "cancel_review" &&
        p.refType === "approval_request" &&
        targets.approvalRequestIds.includes(p.refId),
    );
    let count = active.length;
    for (const cause of own) {
      const now = deps.clock.now();
      count--;
      let dueAt = t.stepDueAt;
      if (count === 0) {
        const stage = await tx.deliveryTicketStage.findFirst({
          where: { deliveryTicketId: id, completedAt: null },
        });
        if (
          !stage ||
          stage.step !== t.step ||
          (stage.dueAt === null) !== (stage.slaSnapshot === null) ||
          stage.dueAt?.getTime() !== t.stepDueAt?.getTime() ||
          (t.pauseRemainingMin === null) !== (stage.dueAt === null)
        )
          throw new AppError("INTERNAL", { message: "暂停工单的当前环节时钟不一致" });
        const hours = await workHoursAt(tx, now);
        const pausedMinutes = await deps.sla.workMinutesBetween(tx, {
          from: t.pausedAt,
          to: now,
          workHours: hours,
        });
        let slaSnapshot =
          stage.slaSnapshot === null ? null : readStageSlaSnapshot(stage.slaSnapshot);
        if (t.pauseRemainingMin !== null) {
          const original = readStageSlaSnapshot(stage.slaSnapshot);
          const next = await deps.sla.dueAt(tx, {
            policy: original.policy,
            amount: t.pauseRemainingMin,
            unit: "work_minutes",
            from: now,
            workHours: hours,
          });
          dueAt = t.pauseRemainingMin === 0 ? now : next.dueAt;
          slaSnapshot = {
            ...original,
            calendarVersion: next.snapshot.calendarVersion,
            computedAt: next.snapshot.computedAt,
          };
        }
        await tx.deliveryTicketStage.update({
          where: { id: stage.id },
          data: {
            dueAt,
            ...(slaSnapshot === null ? {} : { slaSnapshot }),
            pausedMinutes: { increment: pausedMinutes },
            updatedAt: now,
          },
        });
        if (t.step === "plan_confirm")
          await tx.deliveryPlan.updateMany({
            where: { dramaOrderId: t.dramaOrderId },
            data: { staffDueAt: t.waitingOn === "staff" ? dueAt : null, updatedAt: now },
          });
        const subject = { type: "delivery_ticket_stage", id: stage.id };
        await timers.cancel(tx, { subject, kinds: ["sla.breach"] });
        if (dueAt && !stage.isBreached) {
          const armed = await timers.arm(tx, {
            kind: "sla.breach",
            subject,
            key: timerKey("sla.breach", subject),
            fireAt: dueAt,
            entityId: t.entityId,
            storeId: t.storeId,
            payload: { ...readStageSlaSnapshot(slaSnapshot), dueAt: dueAt.toISOString() },
          });
          if (armed.status !== "scheduled")
            throw new AppError("INTERNAL", { message: "恢复环节时限未登记为待执行定时器" });
        }
        resumedTicketIds.push(id);
      }
      await deps.flow.transition(tx, ctx, {
        machine: "delivery_ticket",
        stateField: "step",
        id,
        event: "ticket.resume",
        to: t.step,
        ref: "10:190",
        args: cancelResumeChecked(cause.refId),
        entityId: t.entityId,
        storeId: t.storeId,
        set: {
          pause_count: count,
          ...(count === 0
            ? {
                paused_at: null,
                pause_remaining_min: null,
                step_due_at: dueAt,
              }
            : {}),
        },
        payload: { reason: "cancel_review", refId: cause.refId, releaseEvent },
        emit: {
          type: "ticket.resumed",
          payload: {
            v: 1,
            deliveryTicketId: id,
            orderItemId: t.orderItemId,
            reason: "cancel_review",
            refId: cause.refId,
          },
        },
      });
      await tx.deliveryTicketPause.update({
        where: { id: cause.id },
        data: {
          releasedAt: now,
          releaseEvent,
          updatedAt: now,
        },
      });
      released++;
    }
  }
  for (const id of resumedTicketIds) {
    const before = await tx.deliveryTicketStage.findFirstOrThrow({
      where: { deliveryTicketId: id, completedAt: null },
    });
    await reevaluate(tx, deps, ctx, id);
    if ((await tx.deliveryTicketStage.findUniqueOrThrow({ where: { id: before.id } })).completedAt)
      await timers.cancel(tx, {
        subject: { type: "delivery_ticket_stage", id: before.id },
        kinds: ["sla.breach"],
      });
  }
  return { released, resumedTicketIds };
}
