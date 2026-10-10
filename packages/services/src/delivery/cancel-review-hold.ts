import { AppError, actorColumns, lockRows, uuidv7 } from "../kernel/index.js";
import type { Assembly, IdentityContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import { createTimers } from "../timers/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { cancelHoldChecked } from "./machines.js";
import { orderSidePort } from "./ports.js";
import { readStageSlaSnapshot } from "./stage-sla.js";

const pausable = [
  "assigning",
  "plan_confirm",
  "ad_prep",
  "sample_making",
  "sample_confirm",
  "batch_compose",
  "delivering",
  "awaiting_launch",
  "launch_verify",
];
const ids = (values: readonly string[]) => [...new Set(values)].sort();

/** No locks/writes. Caller reads every owner's targets before prelocking their complete union. */
export async function readCancelReviewHoldTargets(
  tx: Tx,
  assembly: Assembly,
  approvalRequestId: string,
) {
  const cause = await assembly.port(orderSidePort).readCancelReviewCause(tx, approvalRequestId);
  const tickets = await tx.deliveryTicket.findMany({
    where: { orderItemId: { in: [...cause.orderItemIds] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      entityId: true,
      storeId: true,
      dramaId: true,
      dramaOrderId: true,
      orderItemId: true,
      step: true,
      pauseCount: true,
      pausedAt: true,
      pauseRemainingMin: true,
      stepDueAt: true,
      deliveryTicketStages: {
        where: { completedAt: null },
        orderBy: { id: "asc" },
        select: { id: true, step: true, dueAt: true, slaSnapshot: true, isBreached: true },
      },
      deliveryTicketPauses: {
        where: {
          OR: [{ releasedAt: null }, { reason: "cancel_review", refId: approvalRequestId }],
        },
        orderBy: { id: "asc" },
        select: {
          id: true,
          reason: true,
          refType: true,
          refId: true,
          releasedAt: true,
          actorType: true,
          actorId: true,
          client: true,
        },
      },
    },
  });
  if (
    tickets.some((t) => {
      const item = cause.orderItems.find((i) => i.id === t.orderItemId);
      return (
        !item ||
        t.entityId !== cause.entityId ||
        t.storeId !== cause.storeId ||
        t.dramaOrderId !== item.dramaOrderId ||
        t.dramaId !== item.dramaId
      );
    })
  )
    throw new AppError("STATE_NOT_ALLOWED", { message: "取消暂停工单归属不一致" });
  return {
    cause,
    tickets,
    dramaIds: ids(cause.orderItems.map((t) => t.dramaId)),
    dramaOrderIds: ids(cause.orderItems.map((t) => t.dramaOrderId)),
    orderItemIds: ids(cause.orderItemIds),
    deliveryTicketIds: tickets.map((t) => t.id),
  };
}
export type CancelReviewHoldTargets = Awaited<ReturnType<typeof readCancelReviewHoldTargets>>;

/** Same Tx only. Caller must already own the complete multi-owner union, including all low locks.
 * Ticket180 owns its stages/pauses; timers remain last. No changed graph can add a late low lock.
 */
export async function holdCancelReviewPauses(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  targets: CancelReviewHoldTargets,
) {
  const { cause } = targets;
  const check = async () => {
    if (
      JSON.stringify(targets) !==
      JSON.stringify(await readCancelReviewHoldTargets(tx, deps.assembly, cause.approvalRequestId))
    )
      throw new AppError("STATE_NOT_ALLOWED", { message: "取消暂停的锁图已变化，请重试整个事务" });
  };
  await check();
  for (const [table, values] of [
    ["approval_request", [cause.approvalRequestId]],
    ["cancel_request", [cause.requestId]],
    ["cancel_request_line", cause.lineIds],
    ["entity", [cause.entityId]],
    ["store", [cause.storeId]],
    ["drama", targets.dramaIds],
    ["drama_order", targets.dramaOrderIds],
    ["order_item", targets.orderItemIds],
    ["delivery_ticket", targets.deliveryTicketIds],
  ] as const)
    await lockRows(tx, table, values);
  await check();
  const actor = actorColumns(ctx.actor);
  if (
    actor.actorType !== cause.submitActorType ||
    actor.actorId !== cause.submitActorId ||
    actor.client !== cause.submitClient ||
    (ctx.entityId !== null && ctx.entityId !== cause.entityId) ||
    (ctx.storeId !== null && ctx.storeId !== cause.storeId)
  )
    throw new AppError("STATE_NOT_ALLOWED", { message: "取消暂停必须沿用实际审批提交身份" });
  const timers = createTimers({ assembly: deps.assembly });
  let held = 0;
  for (const t of targets.tickets) {
    const active = t.deliveryTicketPauses.filter((p) => p.releasedAt === null);
    const own = t.deliveryTicketPauses.find(
      (p) => p.reason === "cancel_review" && p.refId === cause.approvalRequestId,
    );
    if (
      active.length !== t.pauseCount ||
      t.pauseCount > 0 !== (t.pausedAt !== null) ||
      (t.pauseCount === 0 && t.pauseRemainingMin !== null)
    )
      throw new AppError("INTERNAL", { message: "工单暂停集合与汇总不一致" });
    const stage = t.deliveryTicketStages[0];
    if (pausable.includes(t.step)) {
      if (
        t.deliveryTicketStages.length !== 1 ||
        !stage ||
        stage.step !== t.step ||
        (stage.dueAt === null) !== (stage.slaSnapshot === null) ||
        stage.dueAt?.getTime() !== t.stepDueAt?.getTime() ||
        (t.pauseCount > 0 && (t.pauseRemainingMin === null) !== (stage.dueAt === null))
      )
        throw new AppError("INTERNAL", { message: "待暂停工单的当前环节时钟不一致" });
      if (stage.slaSnapshot !== null) readStageSlaSnapshot(stage.slaSnapshot);
    }
    if (own) {
      if (
        own.releasedAt !== null ||
        own.refType !== "approval_request" ||
        own.actorType !== actor.actorType ||
        own.actorId !== actor.actorId ||
        own.client !== actor.client ||
        !pausable.includes(t.step)
      )
        throw new AppError("STATE_NOT_ALLOWED");
      continue;
    }
    if (!pausable.includes(t.step) || !stage) continue;
    if (cause.approvalStatus !== "pending") throw new AppError("STATE_NOT_ALLOWED");
    const now = deps.clock.now();
    const remaining =
      t.pauseCount > 0
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
        deliveryTicketId: t.id,
        reason: "cancel_review",
        refType: "approval_request",
        refId: cause.approvalRequestId,
        ...actor,
        createdAt: now,
        updatedAt: now,
      },
    });
    await deps.flow.transition(tx, ctx, {
      machine: "delivery_ticket",
      stateField: "step",
      id: t.id,
      event: "ticket.hold",
      to: t.step,
      ref: "10:189",
      args: cancelHoldChecked(cause.approvalRequestId),
      entityId: t.entityId,
      storeId: t.storeId,
      set: {
        pause_count: t.pauseCount + 1,
        ...(t.pauseCount === 0
          ? {
              paused_at: now,
              pause_remaining_min: remaining,
            }
          : {}),
      },
      payload: { reason: "cancel_review", refId: cause.approvalRequestId },
      emit: {
        type: "ticket.held",
        payload: {
          v: 1,
          deliveryTicketId: t.id,
          orderItemId: t.orderItemId,
          reason: "cancel_review",
          refId: cause.approvalRequestId,
        },
      },
    });
    await timers.cancel(tx, {
      subject: { type: "delivery_ticket_stage", id: stage.id },
      kinds: ["sla.breach"],
    });
    held++;
  }
  return { held };
}
