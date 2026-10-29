import { ApprovalSummarySchema } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { cancelAd } from "../ad/index.js";
import { managedStore } from "../authz/index.js";
import type { ApprovalExecutionFacts } from "../approval/index.js";
import type { ReturnResult } from "../billing/index.js";
import { closeCancelReviewDelivery } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { cancelPass, cancelScope } from "./cancel-context.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import type { CancelExecutionGraph } from "./cancel-locks.js";
import { deriveOrder } from "./rederive.js";

/** L3 supplies its own real domain facts through the L1 approval execution port. */
export const cancelExecutionCompleted: ApprovalExecutionFacts = async (tx, ctx, input, row) => {
  const cancel =
    input.domain.type === "cancel_request"
      ? await tx.cancelRequest.findUnique({
          where: { id: input.domain.id },
          include: { cancelRequestLines: true },
        })
      : null;
  return (
    !!cancel &&
    cancel.approvalRequestId === row.id &&
    cancel.kind === row.kind &&
    cancel.entityId === row.entityId &&
    cancel.storeId === row.storeId &&
    cancel.status === "done" &&
    cancel.executedAt !== null &&
    cancel.closedAt !== null &&
    cancel.lineCount === cancel.cancelRequestLines.length &&
    cancel.cancelRequestLines.every(
      (line) =>
        line.executedAt !== null &&
        line.resultSnapshot !== null &&
        line.returnedPoints !== null &&
        line.convertedPoints !== null &&
        line.forfeitedPoints !== null &&
        line.returnedPoints + line.convertedPoints + line.forfeitedPoints === line.refundPoints,
    ) &&
    row.category === "approval" &&
    row.roundNo === 1 &&
    row.subjectType === (row.kind === "order_cancel" ? "drama_order" : "store") &&
    row.subjectId === (row.kind === "order_cancel" ? cancel.dramaOrderId : cancel.storeId) &&
    row.summary.domain?.type === "cancel_request" &&
    row.summary.domain.id === cancel.id &&
    (ctx.entityId === null || ctx.entityId === cancel.entityId) &&
    (ctx.storeId === null || ctx.storeId === cancel.storeId) &&
    (cancel.isExecutedBySystem
      ? ctx.actor.type === "system"
      : ctx.actor.type === "staff" && ctx.actor.id === cancel.executedByStaffId)
  );
};

/** Reading a request never expands staff data scope via an unscoped target lookup. */
export async function readCancelExecutionRequest(tx: Tx, actor: CancelActor, id: string) {
  const r = await tx.cancelRequest.findFirst({
    where: { id, store: managedStore(cancelScope(actor)) },
    include: { cancelRequestLines: { orderBy: { id: "asc" } }, approvalRequest: true },
  });
  if (!r) throw new AppError("NOT_FOUND");
  const a = r.approvalRequest;
  const subject =
    r.kind === "order_cancel"
      ? ["drama_order", r.dramaOrderId]
      : r.kind === "ad_cancel"
        ? ["ad", r.adId]
        : ["store", r.storeId];
  const domain = ApprovalSummarySchema.parse(a.summarySnapshot).domain;
  if (
    !["order_cancel", "ad_cancel", "qualification_cancel"].includes(r.kind) ||
    r.lineCount !== r.cancelRequestLines.length ||
    !r.lineCount ||
    r.cancelRequestLines.some(
      (l) =>
        l.entityId !== r.entityId ||
        l.storeId !== r.storeId ||
        (r.kind === "order_cancel" && l.targetType !== "order_item") ||
        (r.kind === "ad_cancel" && (l.targetType !== "ad" || l.targetId !== r.adId)),
    ) ||
    (r.kind === "ad_cancel" && r.lineCount !== 1) ||
    a.kind !== r.kind ||
    a.category !== "approval" ||
    a.roundNo !== 1 ||
    a.subjectType !== subject[0] ||
    a.subjectId !== subject[1] ||
    a.entityId !== r.entityId ||
    a.storeId !== r.storeId ||
    domain?.type !== "cancel_request" ||
    domain.id !== r.id
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消申请、审批与明细关联不一致" });
  return r;
}
type Request = Awaited<ReturnType<typeof readCancelExecutionRequest>>;
type Line = Request["cancelRequestLines"][number];
type ActualReturn = Pick<ReturnResult, "returnedPoints" | "convertedPoints" | "forfeitedPoints"> &
  Partial<Pick<ReturnResult, "operationId" | "pointHoldId" | "replayed">>;

async function returnLine(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  r: Request,
  line: Line,
): Promise<ActualReturn> {
  if (line.mode === "terminate_only")
    return {
      pointHoldId: line.pointHoldId,
      returnedPoints: 0,
      convertedPoints: 0,
      forfeitedPoints: 0,
    };
  const reasonClass = line.reasonClass as "merchant" | "platform" | "qualification";
  const result =
    line.mode === "release"
      ? await deps.ledger.release(tx, {
          pointHoldId: line.pointHoldId,
          reasonClass,
          title: { refNo: r.approvalRequest.requestNo!, dramaTitles: [] },
          ctx: actor.ctx,
        })
      : await deps.ledger.refund(tx, {
          pointHoldId: line.pointHoldId,
          qty: line.refundPoints,
          reasonClass,
          source: { type: "cancel_request_line", id: line.id },
          refNo: r.approvalRequest.requestNo!,
          ctx: actor.ctx,
        });
  if (result.returnedPoints + result.convertedPoints + result.forfeitedPoints !== line.refundPoints)
    throw new AppError("PRECONDITION_CHANGED", { message: "账本实际退回数量与取消明细不一致" });
  return result;
}
async function saveLine(tx: Tx, line: Line, result: ActualReturn, now: Date) {
  await tx.cancelRequestLine.update({
    where: { id: line.id },
    data: {
      returnedPoints: result.returnedPoints,
      convertedPoints: result.convertedPoints,
      forfeitedPoints: result.forfeitedPoints,
      executedAt: now,
      resultSnapshot: {
        qty: result.returnedPoints + result.convertedPoints + result.forfeitedPoints,
        backToOriginal: result.returnedPoints,
        convertedToAddon: result.convertedPoints,
        forfeited: result.forfeitedPoints,
        lots: [],
      } satisfies Prisma.InputJsonObject,
    },
  });
}
async function finishItem(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  r: Request,
  line: Line,
  result: ActualReturn,
  now: Date,
) {
  const item = await tx.orderItem.findUniqueOrThrow({ where: { id: line.targetId } });
  const amounts = {
    refund_requested_points: item.refundRequestedPoints + line.refundPoints,
    returned_points: item.returnedPoints + result.returnedPoints,
    converted_points: item.convertedPoints + result.convertedPoints,
    forfeited_points: item.forfeitedPoints + result.forfeitedPoints,
    cancel_reason_code: r.reasonCode,
    cancelled_at: now,
  };
  if (line.stage === "live") {
    // Live remains live until actual takedown verification/archival; only its fixed end changes.
    await tx.orderItem.update({
      where: { id: item.id },
      data: {
        refundRequestedPoints: amounts.refund_requested_points,
        returnedPoints: amounts.returned_points,
        convertedPoints: amounts.converted_points,
        forfeitedPoints: amounts.forfeited_points,
        cancelReasonCode: r.reasonCode,
        cancelledAt: now,
        usageEndDate: line.terminationDate!,
        usageEndSource: "early_end",
        lockVersion: { increment: 1 },
        updatedAt: now,
      },
    });
    return;
  }
  await deps.flow.transition(tx, actor.ctx, {
    machine: "order_item",
    stateField: "phase",
    id: item.id,
    event: line.mode === "release" ? "cancel.execute" : "ticket.terminate",
    to:
      line.mode === "release"
        ? "cancelled"
        : result.returnedPoints + result.convertedPoints > 0
          ? "refunded"
          : "terminated",
    args: cancelPass(),
    entityId: r.entityId,
    storeId: r.storeId,
    set: { ...amounts, phase_changed_at: now },
    audit: { mergedInto: { approvalRequestId: r.approvalRequestId } },
    emit: { none: true, primary: "cancel.executed" },
  });
}

/** Sole executor's transaction leaf: close every delivery target before returning any points. */
export async function finishCancelTargets(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  r: Request,
  graph: CancelExecutionGraph,
  now: Date,
) {
  const itemLines = r.cancelRequestLines.filter((l) => l.targetType === "order_item");
  if (graph.delivery.deliveryTicketIds.length) {
    if (!deps.assembly) throw new AppError("INTERNAL", { message: "取消履约收尾缺少真实装配" });
    await closeCancelReviewDelivery(
      tx,
      { ...deps, assembly: deps.assembly },
      actor.ctx,
      graph.delivery,
      {
        cancelRequestId: r.id,
        approvalRequestId: r.approvalRequestId,
        reasonCode: r.reasonCode,
        now,
        lines: itemLines.map((l) => ({
          id: l.id,
          orderItemId: l.targetId,
          stage: l.stage,
          terminationDate: l.terminationDate,
        })),
      },
    );
  }
  for (const line of r.cancelRequestLines) {
    const result =
      line.targetType === "ad"
        ? await cancelAd(
            tx,
            deps,
            actor.ctx,
            {
              adId: line.targetId,
              entityId: r.entityId,
              storeId: r.storeId,
              cancelRequestId: r.id,
              approvalRequestId: r.approvalRequestId,
              reasonCode: r.reasonCode,
              refundPoints: line.refundPoints,
              now,
            },
            () => returnLine(tx, deps, actor, r, line),
          )
        : await returnLine(tx, deps, actor, r, line);
    if (line.targetType === "order_item") await finishItem(tx, deps, actor, r, line, result, now);
    await saveLine(tx, line, result, now);
  }
  const orders = await tx.orderItem.findMany({
    where: { id: { in: itemLines.map((l) => l.targetId) } },
    select: { dramaOrderId: true },
  });
  for (const orderId of [...new Set(orders.map((i) => i.dramaOrderId))].sort()) {
    // Only parent derivation is needed: item phases above are based on actual ledger outcomes.
    await deriveOrder(
      tx,
      { assembly: deps.assembly!, clock: deps.clock, flow: deps.flow },
      orderId,
      { closedCancelRequestId: r.id },
    );
    await deps.timers.cancel(tx, {
      subject: { type: "drama_order", id: orderId },
      kinds: ["order.start"],
    });
  }
}
