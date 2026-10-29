import { paramsAt } from "../config/index.js";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, FiredTimer, Tx } from "../kernel/index.js";
import { readOrderQualificationRound, storeGate } from "../profile/index.js";
import { timerKey } from "../timers/index.js";
import { boundCancelRequests } from "./cancel-binding.js";
import type { CancelDeps } from "./cancel-context.js";
import { lockQualificationGraph, readQualificationGraph } from "./qualification-locks.js";
import { submitQualificationCancel } from "./cancel-submit.js";
import type { OrderStartBinding } from "./start-binding.js";
import { armOrderStart, updateStartSubStatus } from "./start-timer.js";

export async function qualificationDecided(
  tx: Tx,
  start: OrderStartBinding,
  event: DeliveredEvent,
  deps?: CancelDeps,
) {
  if (!["store.qualification.approved", "store.qualification.rejected"].includes(event.type))
    return;
  const { storeId, entityId, submissionId } = event.payload;
  if (typeof storeId !== "string" || typeof entityId !== "string") return;
  const graph = await readQualificationGraph(tx, { storeId, entityId });
  const round = graph.round;
  // Only the current owner's real decision can create an application or reminder.
  if (round && typeof submissionId === "string" && round.submissionId !== submissionId) return;
  const final =
    event.type === "store.qualification.rejected" &&
    round?.approvalStatus === "rejected" &&
    round.outcome === "rejected" &&
    round.finalRejectedAt !== null;
  if (
    final &&
    graph.orderIds.length + graph.adIds.length > 0 &&
    !graph.requests.some((r) => r.kind === "qualification_cancel")
  ) {
    await submitQualificationCancel(
      tx,
      deps ?? boundCancelRequests(),
      {
        ctx: createIdentityContext({
          actor: { type: "system", job: "order.qualification_decided" },
          entityId,
          storeId,
        }),
      },
      {
        entityId,
        storeId,
        requesterStaffId: round.decidedByStaffId,
        submissionId: round.submissionId,
        roundNo: round.roundNo,
      },
    );
    return;
  }
  if (!(await lockQualificationGraph(tx, graph))) return;
  const store = await tx.store.findFirst({
    where: { id: storeId, entityId },
    include: { entity: true },
  });
  if (!store || store.lifecycle !== "active" || store.entity.lifecycle !== "active") return;
  const current = await readOrderQualificationRound(tx, { entityId, storeId });
  if (current && typeof submissionId === "string" && current.submissionId !== submissionId) return;
  const full = (await storeGate(tx, storeId)) === "full";
  if (!full && store.qualificationStatus !== "rejected") return;
  const now = start.clock.now();
  for (const id of graph.orderIds) {
    const order = await tx.dramaOrder.findUniqueOrThrow({ where: { id } });
    if (order.status !== "pending_start" || order.openCancelRequestId) continue;
    if (full) await armOrderStart(tx, start, order);
    await updateStartSubStatus(tx, id, full ? "starting" : "qualification_rejected", now);
    if (
      !full &&
      current?.outcome === "rejected" &&
      current.approvalStatus === "rejected" &&
      current.closedAt &&
      !current.finalRejectedAt
    ) {
      const values = await paramsAt(tx, ["order.rejected_stale_days"], now);
      const subject = { type: "drama_order", id };
      await start.timers.arm(tx, {
        kind: "order.rejected_stale",
        subject,
        key: timerKey("order.rejected_stale", subject, `r${current.roundNo}`),
        fireAt: new Date(
          current.closedAt.getTime() + values["order.rejected_stale_days"] * 86_400_000,
        ),
        entityId,
        storeId,
        payload: {
          v: 1,
          submissionId: current.submissionId,
          roundNo: current.roundNo,
          rejectedAt: current.closedAt.toISOString(),
        },
      });
    }
  }
}

export async function handleOrderRejectedStale(tx: Tx, deps: CancelDeps, timer: FiredTimer) {
  if (timer.subjectType !== "drama_order" || !timer.subjectId) return "skipped" as const;
  const before = await tx.dramaOrder.findUnique({ where: { id: timer.subjectId } });
  if (!before) return "skipped" as const;
  await lockRows(tx, "entity", [before.entityId]);
  await lockRows(tx, "store", [before.storeId]);
  await lockRows(tx, "drama_order", [before.id]);
  const order = await tx.dramaOrder.findUniqueOrThrow({
    where: { id: before.id },
    include: { store: true },
  });
  const current = await readOrderQualificationRound(tx, {
    entityId: order.entityId,
    storeId: order.storeId,
  });
  if (
    order.status !== "pending_start" ||
    order.openCancelRequestId ||
    order.store.lifecycle !== "active" ||
    order.store.qualificationStatus !== "rejected" ||
    !current ||
    current.approvalStatus !== "rejected" ||
    current.outcome !== "rejected" ||
    current.finalRejectedAt ||
    !current.closedAt ||
    current.submissionId !== timer.payload?.submissionId ||
    current.roundNo !== timer.payload?.roundNo ||
    current.closedAt.toISOString() !== timer.payload?.rejectedAt
  )
    return "skipped" as const;
  const actual = await tx.timer.findUnique({ where: { id: timer.id } });
  if (
    !actual ||
    actual.kind !== "order.rejected_stale" ||
    actual.subjectId !== order.id ||
    actual.fireAt > deps.clock.now()
  )
    return "skipped" as const;
  await deps.events.emit(
    tx,
    createIdentityContext({
      actor: { type: "system", job: "order.rejected_stale" },
      entityId: order.entityId,
      storeId: order.storeId,
    }),
    {
      type: "order.rejected_stale",
      aggregate: { type: "drama_order", id: order.id },
      entityId: order.entityId,
      storeId: order.storeId,
      dedupeKey: `tmr:${actual.dedupeKey}`,
      payload: {
        v: 1,
        dramaOrderId: order.id,
        storeId: order.storeId,
        rejectedAt: current.closedAt.toISOString(),
      },
    },
  );
  return "fired" as const;
}
export const handleRejectedStale = (tx: Tx, timer: FiredTimer) =>
  handleOrderRejectedStale(tx, boundCancelRequests(), timer);
