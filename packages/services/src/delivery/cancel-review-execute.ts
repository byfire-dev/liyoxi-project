import type { Approval } from "../approval/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { invalidateZipBundles, readCancelZipTargets } from "../media/index.js";
import { closeCancelReviewPublish, readCancelReviewPublishTargets } from "../publish/index.js";
import { closeSystemFollowUps, readSystemFollowUpCloseTargets } from "../staff/index.js";
import { createTimers } from "../timers/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { cancelTerminateChecked } from "./machines.js";

const ids = (values: readonly string[]) => [...new Set(values)].sort();
export interface CancelReviewExecuteInput {
  readonly cancelRequestId: string;
  readonly approvalRequestId: string;
  readonly reasonCode: string;
  readonly now: Date;
  readonly lines: readonly {
    readonly id: string;
    readonly orderItemId: string;
    readonly stage: string;
    readonly terminationDate: Date | null;
  }[];
}

/** No locking/writes: order prelocks this entire union before any owner starts closing. */
export async function readCancelReviewExecuteTargets(tx: Tx, orderItemIds: readonly string[]) {
  const itemIds = ids(orderItemIds);
  const tickets = await tx.deliveryTicket.findMany({
    where: { orderItemId: { in: itemIds } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      orderItemId: true,
      dramaId: true,
      dramaOrderId: true,
      entityId: true,
      storeId: true,
      step: true,
      pauseCount: true,
      pausedAt: true,
      deliveryTicketStages: {
        where: { completedAt: null },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      deliveryTicketPauses: {
        where: { releasedAt: null },
        orderBy: { id: "asc" },
        select: { id: true },
      },
    },
  });
  const ticketIds = tickets.map((t) => t.id);
  const releases = await tx.deliveryRelease.findMany({
    where: { orderItemId: { in: itemIds } },
    orderBy: { id: "asc" },
    select: { id: true, orderItemId: true, state: true },
  });
  const reissues = await tx.deliveryReissue.findMany({
    where: { deliveryTicketId: { in: ticketIds } },
    orderBy: { id: "asc" },
    select: { id: true, deliveryTicketId: true, status: true },
  });
  const grants = await tx.downloadGrant.findMany({
    where: { orderItemId: { in: itemIds }, state: "active" },
    orderBy: { id: "asc" },
    select: { id: true, deliveryReleaseId: true },
  });
  const publish = await readCancelReviewPublishTargets(tx, itemIds);
  const media = await readCancelZipTargets(
    tx,
    releases.map((r) => r.id),
  );
  const followUps = await readSystemFollowUpCloseTargets(tx, {
    subjects: [
      ...reissues.map((r) => ({ subjectType: "delivery_reissue" as const, subjectId: r.id })),
      ...publish.patrols.map((p) => ({ subjectType: "patrol_task" as const, subjectId: p.id })),
    ],
  });
  return {
    orderItemIds: itemIds,
    tickets,
    releases,
    reissues,
    grants,
    publish,
    media,
    followUps,
    staffIds: followUps.staffIds,
    followUpIds: followUps.followUpIds,
    dramaIds: ids(tickets.map((t) => t.dramaId)),
    dramaOrderIds: ids(tickets.map((t) => t.dramaOrderId)),
    deliveryTicketIds: ticketIds,
    deliveryReleaseIds: releases.map((r) => r.id),
    approvalRequestIds: publish.approvalRequestIds,
    channelAccountIds: publish.channelAccountIds,
    launchTaskIds: publish.launchTaskIds,
    patrolTaskIds: publish.patrolTaskIds,
    takedownTaskIds: publish.takedownTaskIds,
    zipBundleIds: media.zipBundleIds,
    fileObjectIds: media.fileObjectIds,
  };
}
export type CancelReviewExecuteTargets = Awaited<ReturnType<typeof readCancelReviewExecuteTargets>>;
export type CancelReviewExecuteDeps = DeliveryCoreDeps & {
  readonly approval: Pick<Approval, "withdraw">;
};

/** Same cancellation Tx, before returning points. Every owner lock is already held. */
export async function closeCancelReviewDelivery(
  tx: Tx,
  deps: CancelReviewExecuteDeps,
  ctx: IdentityContext,
  targets: CancelReviewExecuteTargets,
  input: CancelReviewExecuteInput,
) {
  if (
    JSON.stringify(targets) !==
    JSON.stringify(await readCancelReviewExecuteTargets(tx, targets.orderItemIds))
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消交付锁图已变化" });
  await lockRows(tx, "delivery_ticket", targets.deliveryTicketIds);
  await lockRows(tx, "delivery_release", targets.deliveryReleaseIds);
  const timers = createTimers({ assembly: deps.assembly });
  for (const t of targets.tickets) {
    const line = input.lines.find((l) => l.orderItemId === t.orderItemId);
    if (!line || ["archived", "terminated"].includes(t.step))
      throw new AppError("PRECONDITION_CHANGED");
    if (
      t.deliveryTicketPauses.length !== t.pauseCount ||
      t.pauseCount > 0 !== (t.pausedAt !== null)
    )
      throw new AppError("INTERNAL", { message: "取消工单暂停汇总不一致" });
    const live = line.stage === "live";
    if (live !== ["in_service", "takedown"].includes(t.step))
      throw new AppError("PRECONDITION_CHANGED");
    await deps.flow.transition(tx, ctx, {
      machine: "delivery_ticket",
      stateField: "step",
      id: t.id,
      event: "ticket.terminate",
      to: live ? "takedown" : "terminated",
      ref: live ? "10:192" : "10:191",
      args: cancelTerminateChecked(input.cancelRequestId, input.approvalRequestId),
      entityId: t.entityId,
      storeId: t.storeId,
      set: {
        pause_count: 0,
        paused_at: null,
        pause_remaining_min: null,
        ...(t.step === "takedown" ? {} : { step_entered_at: input.now }),
        step_due_at: null,
        waiting_on: live ? "staff" : "none",
        ...(live ? {} : { terminated_at: input.now }),
      },
      payload: { cancelRequestId: input.cancelRequestId, reasonCode: input.reasonCode },
      emit: {
        type: "ticket.terminated",
        payload: {
          v: 1,
          deliveryTicketId: t.id,
          orderItemId: t.orderItemId,
          cancelRequestId: input.cancelRequestId,
        },
      },
    });
    await tx.deliveryTicketPause.updateMany({
      where: { id: { in: t.deliveryTicketPauses.map((p) => p.id) }, releasedAt: null },
      data: { releasedAt: input.now, releaseEvent: "terminated", updatedAt: input.now },
    });
    for (const stage of t.deliveryTicketStages)
      await timers.cancel(tx, {
        subject: { type: "delivery_ticket_stage", id: stage.id },
        kinds: ["sla.breach"],
      });
  }
  await tx.deliveryReissue.updateMany({
    where: { id: { in: targets.reissues.map((r) => r.id) }, status: "open" },
    data: { status: "cancelled", closedAt: input.now, updatedAt: input.now },
  });
  await closeSystemFollowUps(tx, ctx, {
    subjects: targets.reissues.map((r) => ({
      subjectType: "delivery_reissue" as const,
      subjectId: r.id,
    })),
    now: input.now,
  });
  await tx.downloadGrant.updateMany({
    where: { id: { in: targets.grants.map((g) => g.id) }, state: "active" },
    data: {
      state: "revoked",
      endedAt: input.now,
      revokeReason: "订单项取消或退回",
      updatedAt: input.now,
    },
  });
  await tx.deliveryRelease.updateMany({
    where: { id: { in: targets.deliveryReleaseIds }, state: "pushed" },
    data: { state: "closed", closedAt: input.now, closeReason: "cancelled", updatedAt: input.now },
  });
  await closeCancelReviewPublish(tx, deps, ctx, targets.publish, input);
  await invalidateZipBundles(tx, targets.media, input.now);
  return { terminatedTicketIds: targets.deliveryTicketIds };
}
