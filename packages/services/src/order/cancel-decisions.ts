import {
  CancelApproveBodySchema,
  CancelRejectBodySchema,
  CancelVoidBodySchema,
  CancelWithdrawBodySchema,
} from "@liyoxi/contract";
import type {
  CancelApproveBody,
  CancelRejectBody,
  CancelVoidBody,
  CancelWithdrawBody,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { clearAdCancelRequestPointers, readAdCancelFacts } from "../ad/index.js";
import type { ApprovalRow } from "../approval/index.js";
import { assertConfirm, assertStepUp } from "../authz/index.js";
import { releaseCancelReviewPauses } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { storeGate } from "../profile/index.js";
import { timerKey } from "../timers/index.js";
import { approveAdCancel, rejectAdCancel, withdrawAdCancel, voidAdCancel } from "./ad-cancel.js";
import {
  cancelCall,
  cancelPass,
  cancelScope,
  CancelRecheckError,
  withCancelCall,
} from "./cancel-context.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import { readCancelExecutionRequest } from "./cancel-execution.js";
import { cancelStaff, checkCancelStaff, requireCancelPermission } from "./cancel-identity.js";
import {
  cancelDecisionGraph,
  cancelIds,
  prelockCancelDecision,
  readCancelDecisionGraph,
} from "./cancel-request-locks.js";
import { CLOSED_CANCEL_ITEMS } from "./cancel-quote.js";
import { revalidateCancel } from "./cancel-revalidation.js";
import { deriveOrder } from "./rederive.js";
import { boundOrderStart } from "./start-binding.js";
import { armOrderStart } from "./start-timer.js";

export async function checkOrderCancel(tx: Tx, row: ApprovalRow, args: unknown) {
  const c = cancelCall(tx),
    r = await readCancelExecutionRequest(tx, c.actor, c.requestId!);
  if (r.approvalRequestId !== row.id || !["order_cancel", "qualification_cancel"].includes(r.kind))
    throw new AppError("PRECONDITION_CHANGED");
  if (!c.auto) {
    cancelDecisionGraph(tx, r.id);
    const body = CancelApproveBodySchema.parse(args);
    assertConfirm(body.confirm, {
      requestNo: row.requestNo!,
      totalRefundPoints: r.totalRefundPoints,
    });
  }
  const at = (await c.deps.ledger.lockAccount(tx, r.entityId)).now;
  const entry = await revalidateCancel(
    tx,
    { scope: cancelScope(c.actor), requestId: r.id, phase: "approve" },
    at,
  );
  if (!entry.ok) throw new CancelRecheckError(r.id, "approve", entry);
  const previous =
    r.recheckLog && typeof r.recheckLog === "object" && !Array.isArray(r.recheckLog)
      ? r.recheckLog
      : {};
  await tx.cancelRequest.update({
    where: { id: r.id },
    data: { recheckLog: { ...previous, approve: entry } as Prisma.InputJsonValue },
  });
}

export async function isCancelSubjectInvalid(tx: Tx, id: string, includeLifecycle = false) {
  const r = await tx.cancelRequest.findUniqueOrThrow({
    where: { id },
    include: { cancelRequestLines: true, store: { include: { entity: true } } },
  });
  if (includeLifecycle && (r.store.lifecycle !== "active" || r.store.entity.lifecycle !== "active"))
    return true;
  for (const line of r.cancelRequestLines) {
    if (line.targetType === "order_item") {
      const item = await tx.orderItem.findUnique({ where: { id: line.targetId } });
      if (!item || CLOSED_CANCEL_ITEMS.includes(item.phase)) return true;
    } else {
      const ad = await readAdCancelFacts(tx, line.targetId);
      if (!ad || ["confirmed", "cancelled"].includes(ad.status)) return true;
    }
  }
  return false;
}
export async function isOrderSubjectInvalidForWithdrawal(tx: Tx, row: ApprovalRow) {
  const c = cancelCall(tx);
  requireCancelPermission(c.deps, c.actor, "finance.refund.approve");
  const graph = cancelDecisionGraph(tx, c.requestId!);
  if (!graph.execution.approvalIds.includes(row.id)) throw new AppError("PRECONDITION_CHANGED");
  return isCancelSubjectInvalid(tx, c.requestId!);
}

async function closeRequest(
  tx: Tx,
  id: string,
  reason: "rejected" | "withdrawn" | "voided",
  note: string | null,
  merged: boolean,
) {
  const c = cancelCall(tx),
    r = await readCancelExecutionRequest(tx, c.actor, id, { allowRequester: true });
  const graph = cancelDecisionGraph(tx, id);
  await c.deps.flow.transition(tx, c.actor.ctx, {
    machine: "cancel_request",
    stateField: "status",
    id,
    event: reason === "voided" ? "cancel.void" : `approval.${reason}`,
    entityId: r.entityId,
    storeId: r.storeId,
    args: cancelPass(),
    set: {
      closed_at: c.deps.clock.now(),
      close_reason: reason,
      close_note: reason === "voided" ? note : null,
    },
    audit: merged
      ? { mergedInto: { approvalRequestId: r.approvalRequestId } }
      : {
          stream: "ops",
          category: "refund",
          action: "order.cancel_request.void",
          summary: "作废取消申请",
          target: { type: "cancel_request", id },
          entityId: r.entityId,
          storeId: r.storeId,
          reason: { code: "voided", text: note },
        },
    emit: { type: `cancel.${reason}`, payload: { v: 1, cancelRequestId: id } },
  });
  if (graph.pauses.deliveryTicketIds.length) {
    if (!c.deps.assembly) throw new AppError("INTERNAL", { message: "取消恢复缺少真实履约装配" });
    await releaseCancelReviewPauses(tx, { ...c.deps, assembly: c.deps.assembly }, c.actor.ctx, {
      targets: graph.pauses,
      releaseEvent: reason,
    });
  }
  const items = await tx.orderItem.findMany({
    where: {
      id: {
        in: r.cancelRequestLines
          .filter((l) => l.targetType === "order_item")
          .map((l) => l.targetId),
      },
    },
    select: { dramaOrderId: true },
  });
  for (const orderId of cancelIds(items.map((i) => i.dramaOrderId))) {
    await deriveOrder(
      tx,
      { assembly: c.deps.assembly!, flow: c.deps.flow, clock: c.deps.clock },
      orderId,
      { closedCancelRequestId: id },
    );
    const order = await tx.dramaOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (
      order.status === "pending_start" &&
      !order.openCancelRequestId &&
      (await storeGate(tx, order.storeId)) === "full"
    )
      await armOrderStart(tx, boundOrderStart(), order);
  }
  await clearAdCancelRequestPointers(tx, {
    entityId: r.entityId,
    storeId: r.storeId,
    cancelRequestId: id,
    adIds: r.cancelRequestLines.filter((l) => l.targetType === "ad").map((l) => l.targetId),
    now: c.deps.clock.now(),
  });
  await c.deps.timers.cancel(tx, {
    subject: { type: "approval_request", id: r.approvalRequestId },
    kinds: ["sla.breach"],
    keyPrefix: timerKey(
      "sla.breach",
      { type: "approval_request", id: r.approvalRequestId },
      "execution",
    ),
  });
}
export async function closeOrderCancelCallback(
  tx: Tx,
  row: ApprovalRow,
  reason: "rejected" | "withdrawn",
) {
  const c = cancelCall(tx),
    r = await readCancelExecutionRequest(tx, c.actor, c.requestId!, { allowRequester: true });
  if (r.approvalRequestId !== row.id || row.status !== reason)
    throw new AppError("PRECONDITION_CHANGED");
  await closeRequest(tx, r.id, reason, null, true);
}

async function lockRequest(tx: Tx, actor: CancelActor, id: string, allowRequester = false) {
  await readCancelExecutionRequest(tx, actor, id, { allowRequester });
  const graph = await readCancelDecisionGraph(tx, id);
  await prelockCancelDecision(tx, graph, actor.staff ? [actor.staff.staff.id] : []);
  if (actor.ctx.actor.type !== "system") await checkCancelStaff(tx, actor, true);
  return readCancelExecutionRequest(tx, actor, id, { allowRequester });
}
export async function approveCancelRequest(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelApproveBody,
) {
  const body = CancelApproveBodySchema.parse(input),
    staff = requireCancelPermission(deps, actor, "finance.refund.approve");
  const first = await readCancelExecutionRequest(tx, actor, id);
  if (first.kind === "ad_cancel") {
    await approveAdCancel(tx, deps, actor, id, body);
    return id;
  }
  const r = await lockRequest(tx, actor, id);
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await deps.approval.approve(tx, actor.ctx, {
      approvalId: r.approvalRequestId,
      staff,
      lockVersion: body.lockVersion,
      confirmChecks: body.confirmChecks,
      args: body,
      audit: {
        stream: "ops",
        category: "refund",
        action: "order.cancel_request.approve",
        summary: "审批通过取消申请",
        target: { type: "cancel_request", id },
        entityId: r.entityId,
        storeId: r.storeId,
      },
    });
    const items = await tx.orderItem.findMany({
      where: {
        id: {
          in: r.cancelRequestLines
            .filter((l) => l.targetType === "order_item")
            .map((l) => l.targetId),
        },
      },
      select: { dramaOrderId: true },
    });
    for (const orderId of cancelIds(items.map((i) => i.dramaOrderId)))
      await deriveOrder(
        tx,
        { assembly: deps.assembly!, flow: deps.flow, clock: deps.clock },
        orderId,
      );
    return id;
  });
}
export async function rejectCancelRequest(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelRejectBody,
) {
  const body = CancelRejectBodySchema.parse(input),
    staff = requireCancelPermission(deps, actor, "finance.refund.approve", true);
  const first = await readCancelExecutionRequest(tx, actor, id);
  if (first.kind === "ad_cancel") {
    await rejectAdCancel(tx, deps, actor, id, body);
    return id;
  }
  const r = await lockRequest(tx, actor, id);
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await deps.approval.reject(tx, actor.ctx, { approvalId: r.approvalRequestId, staff, ...body });
    return id;
  });
}
export async function withdrawCancelRequest(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelWithdrawBody,
) {
  const body = CancelWithdrawBodySchema.parse(input),
    staff = actor.ctx.actor.type === "system" ? undefined : cancelStaff(actor);
  const first = await readCancelExecutionRequest(tx, actor, id, { allowRequester: true });
  if (first.kind === "ad_cancel") {
    await withdrawAdCancel(tx, deps, actor, id, body);
    return id;
  }
  if (staff && staff.staff.id !== first.approvalRequest.requesterStaffId)
    assertStepUp(staff, "finance.refund.approve", deps.clock.now());
  const r = await lockRequest(tx, actor, id, true);
  if (!staff && !(await isCancelSubjectInvalid(tx, id, true)))
    throw new AppError("APPROVAL_WITHDRAW_FORBIDDEN");
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await deps.approval.withdraw(tx, actor.ctx, {
      approvalId: r.approvalRequestId,
      ...(staff ? { staff } : {}),
      ...body,
    });
    return id;
  });
}
export async function voidCancelRequest(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelVoidBody,
) {
  const body = CancelVoidBodySchema.parse(input),
    staff =
      actor.ctx.actor.type === "system"
        ? undefined
        : requireCancelPermission(deps, actor, "order.refund.request");
  const first = await readCancelExecutionRequest(tx, actor, id, { allowRequester: true });
  if (first.kind === "ad_cancel") {
    await voidAdCancel(tx, deps, actor, id, body);
    return id;
  }
  const r = await lockRequest(tx, actor, id, true);
  if (r.status !== "pending_execution" || r.closedAt || r.approvalRequest.status !== "approved")
    throw new AppError("STATE_NOT_ALLOWED");
  if (
    staff
      ? staff.staff.id !== r.approvalRequest.requesterStaffId
      : !(await isCancelSubjectInvalid(tx, id, true))
  )
    throw new AppError("PERMISSION_DENIED");
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await closeRequest(tx, id, "voided", body.note, false);
    return id;
  });
}
