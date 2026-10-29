import {
  AdCancelCoreSubmitBodySchema,
  CancelApproveBodySchema,
  CancelExecuteBodySchema,
  CancelRejectBodySchema,
  CancelVoidBodySchema,
  CancelWithdrawBodySchema,
} from "@liyoxi/contract";
import type {
  AdCancelCoreSubmitBody,
  CancelApproveBody,
  CancelExecuteBody,
  CancelRejectBody,
  CancelVoidBody,
  CancelWithdrawBody,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import type { SlaPolicy } from "@liyoxi/shared/workcal";
import {
  cancelAd,
  claimAdCancelRequest,
  clearAdCancelRequestPointers,
  readAdCancelFacts,
} from "../ad/index.js";
import type { ApprovalRow } from "../approval/index.js";
import { assertConfirm, assertPermission, assertStepUp, managedStore } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdempotencyContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import { timerKey } from "../timers/index.js";
import {
  cancelCall,
  cancelPass,
  cancelScope,
  CancelRecheckError,
  withCancelCall,
} from "./cancel-context.js";
import type { AdCancelSubmissionCompanion, CancelActor, CancelDeps } from "./cancel-context.js";
import {
  assertAdCancelTargetsLocked,
  lockAdCancelSubmission,
  prelockAdCancelTargets,
  readAdCancelTargetGraph,
} from "./cancel-locks.js";
import { boundCancelAdItems, quoteAdCancel } from "./cancel-quote.js";
import { revalidateCancel } from "./cancel-revalidation.js";
import { finishCancelTargets, readCancelExecutionRequest } from "./cancel-execution.js";
import { prelockCancelExecutionGraph, readCancelExecutionGraph } from "./cancel-locks.js";
import { runCancelUseCase } from "./cancel-use-case.js";

const executionKey = (id: string) =>
  timerKey("sla.breach", { type: "approval_request", id }, "execution");
function staffIdentity(actor: CancelActor) {
  if (
    actor.ctx.actor.type !== "staff" ||
    !actor.staff ||
    actor.ctx.actor.id !== actor.staff.staff.id
  )
    throw new AppError("PERMISSION_DENIED");
  return actor.staff;
}
async function staffActor(tx: Tx, actor: CancelActor) {
  const staff = staffIdentity(actor);
  await lockRows(tx, "staff", [staff.staff.id], "share");
  if (!(await tx.staff.findFirst({ where: { id: staff.staff.id, status: "active" } })))
    throw new AppError("PERMISSION_DENIED");
  return staff;
}
async function requestOf(tx: Tx, actor: CancelActor, id: string) {
  const r = await tx.cancelRequest.findFirst({
    where: { id, store: managedStore(cancelScope(actor)) },
    include: { cancelRequestLines: { orderBy: { id: "asc" } }, approvalRequest: true },
  });
  if (!r || r.kind !== "ad_cancel") throw new AppError("NOT_FOUND");
  const a = r.approvalRequest,
    l = r.cancelRequestLines[0];
  if (
    !r.adId ||
    r.lineCount !== 1 ||
    r.cancelRequestLines.length !== 1 ||
    !l ||
    l.targetType !== "ad" ||
    l.targetId !== r.adId ||
    l.entityId !== r.entityId ||
    l.storeId !== r.storeId ||
    a.kind !== r.kind ||
    a.subjectType !== "ad" ||
    a.subjectId !== r.adId ||
    a.entityId !== r.entityId ||
    a.storeId !== r.storeId ||
    a.roundNo !== 1
  )
    throw new AppError("PRECONDITION_CHANGED");
  return r;
}
async function lockedRequest(tx: Tx, actor: CancelActor, id: string) {
  await requestOf(tx, actor, id); // scoped 404 before exposing the graph
  const graph = await readAdCancelTargetGraph(tx, [id]);
  await prelockAdCancelTargets(tx, graph, actor.staff ? [actor.staff.staff.id] : []);
  return requestOf(tx, actor, id);
}
async function invalidTarget(tx: Tx, r: Awaited<ReturnType<typeof requestOf>>) {
  const store = await tx.store.findUniqueOrThrow({
    where: { id: r.storeId },
    include: { entity: true },
  });
  const ad = await readAdCancelFacts(tx, r.adId!);
  return (
    store.lifecycle !== "active" ||
    store.entity.lifecycle !== "active" ||
    !ad ||
    ["confirmed", "cancelled"].includes(ad.status)
  );
}
/** A15：真实财务代撤只接受广告终局；主体/门店失效仍走原系统路径。 */
export async function isAdSubjectInvalidForWithdrawal(
  tx: Tx,
  row: { readonly id: string; readonly status: string },
) {
  const c = cancelCall(tx),
    staff = staffIdentity(c.actor);
  assertPermission(staff, "finance.refund.approve", c.deps.clock.now());
  if (!c.requestId) throw new AppError("INTERNAL");
  await assertAdCancelTargetsLocked(tx, c.requestId);
  const r = await requestOf(tx, c.actor, c.requestId);
  if (
    r.approvalRequestId !== row.id ||
    r.approvalRequest.status !== row.status ||
    r.status !== "pending_approval"
  )
    throw new AppError("PRECONDITION_CHANGED");
  if (staff.staff.id === r.approvalRequest.requesterStaffId) return false;
  const requesterId = r.approvalRequest.requesterStaffId;
  if (requesterId === null) return false;
  const requester = await tx.staff.findUnique({ where: { id: requesterId } });
  const ad = await readAdCancelFacts(tx, r.adId!);
  return (
    requester?.status === "active" && ad !== null && ["confirmed", "cancelled"].includes(ad.status)
  );
}
export async function validateAdCancelSubmission(
  tx: Tx,
  adId: string,
  body: AdCancelCoreSubmitBody,
  approvalId: string,
) {
  const c = cancelCall(tx),
    ad = await lockAdCancelSubmission(tx, adId, cancelScope(c.actor));
  if (c.submissionCompanion) {
    c.submissionTarget = Object.freeze({
      actor: c.actor,
      approvalId,
      adId: ad.id,
      entityId: ad.entityId,
      storeId: ad.storeId,
    });
    // service_ticket270 必须在全部目标170之后、首次账户420之前取得。
    await c.submissionCompanion.beforeAccount(tx, c.submissionTarget);
  }
  // Real Tf/advance after every lower business lock; quote and ledger share this account clock.
  const at = (await c.deps.ledger.lockAccount(tx, ad.entityId)).now;
  const q = await quoteAdCancel(
    tx,
    { scope: cancelScope(c.actor), adId, body: { reasonCode: body.reasonCode } },
    at,
  );
  if (q.blockers.length)
    throw new AppError("AD_NOT_CANCELLABLE", {
      details: {
        reason: q.blockers[0]!.reason,
        boundOrderItemIds: await boundCancelAdItems(tx, adId),
      },
    });
  if (q.totalRefundPoints !== body.expect.totalRefundPoints)
    throw new AppError("CANCEL_QUOTE_CHANGED", { details: { quote: q } });
  c.quote = q;
}
export async function checkAdCancel(tx: Tx, row: ApprovalRow) {
  const c = cancelCall(tx),
    r = await requestOf(tx, c.actor, c.requestId!);
  if (r.approvalRequestId !== row.id) throw new AppError("PRECONDITION_CHANGED");
  const at = (await c.deps.ledger.lockAccount(tx, r.entityId)).now;
  const entry = await revalidateCancel(
    tx,
    { scope: cancelScope(c.actor), requestId: r.id, phase: "approve" },
    at,
  );
  if (!entry.ok) throw new CancelRecheckError(r.id, "approve", entry);
  await tx.cancelRequest.update({
    where: { id: r.id },
    data: {
      recheckLog: { ...jsonObject(r.recheckLog), approve: entry } as Prisma.InputJsonValue,
    },
  });
}
const jsonObject = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function audit(r: { id: string; entityId: string; storeId: string }, action: string) {
  return {
    stream: "ops" as const,
    category: "approval" as const,
    action: `order.cancel_request.${action}` as const,
    summary: "处理广告取消申请",
    target: { type: "cancel_request" as const, id: r.id },
    entityId: r.entityId,
    storeId: r.storeId,
  };
}
async function transition(
  tx: Tx,
  r: Awaited<ReturnType<typeof requestOf>>,
  event: string,
  set: Record<string, unknown>,
  emitted:
    | "cancel.approved"
    | "cancel.rejected"
    | "cancel.withdrawn"
    | "cancel.voided"
    | "cancel.executed",
  extra: Record<string, unknown> = {},
  merged = false,
) {
  const c = cancelCall(tx);
  return c.deps.flow.transition(tx, c.actor.ctx, {
    machine: "cancel_request",
    stateField: "status",
    id: r.id,
    event,
    set,
    entityId: r.entityId,
    storeId: r.storeId,
    audit: merged
      ? { mergedInto: { approvalRequestId: r.approvalRequestId } }
      : audit(r, event.split(".").at(-1)!),
    emit: { type: emitted, payload: { v: 1, cancelRequestId: r.id, ...extra } },
    args: cancelPass(),
  });
}
export async function approveAdCancelCallback(tx: Tx, row: ApprovalRow) {
  const c = cancelCall(tx),
    r = await requestOf(tx, c.actor, c.requestId!);
  if (r.approvalRequestId !== row.id || row.status !== "approved")
    throw new AppError("PRECONDITION_CHANGED");
  if (c.auto) return finishAdCancel(tx, r, true, []);
  const at = row.decidedAt!,
    values = await paramsAt(tx, ["sla.review.refund_execute"], at);
  const policy = values["sla.review.refund_execute"] as SlaPolicy;
  const deadline = await c.deps.sla.dueAt(tx, {
    policy: "review.refund_execute",
    amount: policy.amount,
    unit: policy.unit,
    from: at,
    workHours: await workHoursAt(tx, at),
  });
  await transition(
    tx,
    r,
    "approval.approved",
    { exec_due_at: deadline.dueAt, sla_snapshot: { ...deadline.snapshot } },
    "cancel.approved",
    { execDueAt: deadline.dueAt.toISOString() },
    true,
  );
  await c.deps.timers.arm(tx, {
    kind: "sla.breach",
    subject: { type: "approval_request", id: row.id },
    key: executionKey(row.id),
    fireAt: deadline.dueAt,
    entityId: r.entityId,
    storeId: r.storeId,
    payload: { ...deadline.snapshot, purpose: "execution", dueAt: deadline.dueAt.toISOString() },
  });
}
export async function closeAdCancelCallback(
  tx: Tx,
  row: ApprovalRow,
  reason: "rejected" | "withdrawn",
) {
  const c = cancelCall(tx),
    r = await requestOf(tx, c.actor, c.requestId!);
  if (row.id !== r.approvalRequestId || row.status !== reason)
    throw new AppError("PRECONDITION_CHANGED");
  await closeAdCancel(tx, r, reason, null, true);
}
async function closeAdCancel(
  tx: Tx,
  r: Awaited<ReturnType<typeof requestOf>>,
  reason: "rejected" | "withdrawn" | "voided",
  note: string | null,
  merged = false,
) {
  const c = cancelCall(tx),
    ad = await readAdCancelFacts(tx, r.adId!);
  const mayCloseClearedPointer =
    ad?.openCancelRequestId === null &&
    ((c.actor.ctx.actor.type === "system" && (await invalidTarget(tx, r))) ||
      (reason === "withdrawn" &&
        merged &&
        c.actor.ctx.actor.type === "staff" &&
        c.actor.ctx.actor.id !== r.approvalRequest.requesterStaffId &&
        (await isAdSubjectInvalidForWithdrawal(tx, r.approvalRequest))));
  if (!ad || (ad.openCancelRequestId !== r.id && !mayCloseClearedPointer))
    throw new AppError("PRECONDITION_CHANGED");
  await clearAdCancelRequestPointers(tx, {
    entityId: r.entityId,
    storeId: r.storeId,
    cancelRequestId: r.id,
    adIds: [r.adId!],
    now: c.deps.clock.now(),
  });
  await c.deps.timers.cancel(tx, {
    subject: { type: "approval_request", id: r.approvalRequestId },
    kinds: ["sla.breach"],
    keyPrefix: executionKey(r.approvalRequestId),
  });
  await transition(
    tx,
    r,
    reason === "voided" ? "cancel.void" : `approval.${reason}`,
    { closed_at: c.deps.clock.now(), close_reason: reason, close_note: note },
    `cancel.${reason}`,
    {},
    merged,
  );
}
async function finishAdCancel(
  tx: Tx,
  r: Awaited<ReturnType<typeof requestOf>>,
  auto: boolean,
  checks: readonly string[],
) {
  const c = cancelCall(tx),
    line = r.cancelRequestLines[0]!,
    now = c.deps.clock.now();
  const result = await cancelAd(
    tx,
    c.deps,
    c.actor.ctx,
    {
      adId: r.adId!,
      entityId: r.entityId,
      storeId: r.storeId,
      cancelRequestId: r.id,
      approvalRequestId: r.approvalRequestId,
      reasonCode: r.reasonCode,
      refundPoints: line.refundPoints,
      now,
    },
    async () => {
      if (line.mode === "terminate_only")
        return { returnedPoints: 0, convertedPoints: 0, forfeitedPoints: 0 };
      const reasonClass = line.reasonClass as "merchant" | "platform" | "qualification";
      const result =
        line.mode === "release"
          ? await c.deps.ledger.release(tx, {
              pointHoldId: line.pointHoldId,
              reasonClass,
              title: { refNo: r.approvalRequest.requestNo!, dramaTitles: [] },
              ctx: c.actor.ctx,
            })
          : await c.deps.ledger.refund(tx, {
              pointHoldId: line.pointHoldId,
              qty: line.refundPoints,
              reasonClass,
              source: { type: "cancel_request_line", id: line.id },
              refNo: r.approvalRequest.requestNo!,
              ctx: c.actor.ctx,
            });
      return result;
    },
  );
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
      },
    },
  });
  await c.deps.timers.cancel(tx, {
    subject: { type: "approval_request", id: r.approvalRequestId },
    kinds: ["sla.breach"],
    keyPrefix: executionKey(r.approvalRequestId),
  });
  await transition(
    tx,
    r,
    auto ? "cancel.auto_execute" : "cancel.execute",
    {
      executed_at: now,
      closed_at: now,
      is_executed_by_system: auto,
      executed_by_staff_id: auto ? null : c.actor.staff!.staff.id,
      exec_confirm_checks: [...checks],
    },
    "cancel.executed",
    { isAutoExecuted: auto },
  );
  if (!auto)
    await c.deps.approval.recordExecuted(tx, c.actor.ctx, {
      approvalId: r.approvalRequestId,
      domain: { type: "cancel_request", id: r.id },
    });
}
export async function submitAdCancel(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  adId: string,
  input: AdCancelCoreSubmitBody,
  submissionCompanion?: AdCancelSubmissionCompanion,
) {
  if (
    submissionCompanion &&
    (typeof submissionCompanion.beforeAccount !== "function" ||
      typeof submissionCompanion.afterCreated !== "function")
  )
    throw new AppError("INTERNAL", { message: "广告取消提交伴随必须成对提供" });
  const body = AdCancelCoreSubmitBodySchema.parse(input),
    staff = await staffActor(tx, actor);
  assertPermission(staff, "order.refund.request", deps.clock.now());
  const ad = await readAdCancelFacts(tx, adId, staff.scope);
  if (!ad) throw new AppError("NOT_FOUND");
  const requestId = uuidv7(),
    call = { deps, actor, requestId, submissionCompanion };
  return withCancelCall(tx, call, async () => {
    const submitted = await deps.approval.submit(tx, actor.ctx, {
      kind: "ad_cancel",
      subjectType: "ad",
      subjectId: ad.id,
      entityId: ad.entityId,
      storeId: ad.storeId,
      input: body,
    });
    const q = cancelCall(tx).quote!,
      l = q.lines[0]!,
      now = new Date(q.quotedAt);
    await tx.cancelRequest.create({
      data: {
        id: requestId,
        approvalRequestId: submitted.approvalId,
        kind: "ad_cancel",
        entityId: ad.entityId,
        storeId: ad.storeId,
        adId: ad.id,
        reasonCode: body.reasonCode,
        note: body.note,
        lineCount: 1,
        totalBasePoints: q.totalBasePoints,
        totalDeductPoints: q.totalDeductPoints,
        totalRefundPoints: q.totalRefundPoints,
        status: "pending_approval",
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.cancelRequestLine.create({
      data: {
        id: uuidv7(),
        cancelRequestId: requestId,
        entityId: ad.entityId,
        storeId: ad.storeId,
        targetType: "ad",
        targetId: ad.id,
        pointHoldId: ad.pointHoldId,
        mode: l.mode,
        stage: l.stage,
        stepAtSubmit: l.stepAtSubmit,
        reasonClass: l.reasonClass,
        chargePoints: l.chargePoints,
        priorRequestedPoints: l.priorRequestedPoints,
        ratioBp: l.ratioBp,
        deductPoints: l.deductPoints,
        deductNote: l.deductNote,
        refundPoints: l.refundPoints,
        previewSnapshot: l.preview,
        createdAt: now,
      },
    });
    await claimAdCancelRequest(tx, {
      adId: ad.id,
      entityId: ad.entityId,
      storeId: ad.storeId,
      cancelRequestId: requestId,
      now,
    });
    await deps.flow.transition(tx, actor.ctx, {
      machine: "cancel_request",
      stateField: "status",
      id: requestId,
      event: "cancel.submit",
      created: true,
      entityId: ad.entityId,
      storeId: ad.storeId,
      audit: { mergedInto: { approvalRequestId: submitted.approvalId } },
      args: cancelPass(),
      emit: {
        type: "cancel.submitted",
        payload: {
          v: 1,
          cancelRequestId: requestId,
          approvalRequestId: submitted.approvalId,
          kind: "ad_cancel",
          subjectType: "ad",
          subjectId: ad.id,
          totalRefundPoints: q.totalRefundPoints,
        },
      },
    });
    if (submissionCompanion) {
      const target = cancelCall(tx).submissionTarget;
      if (!target || target.approvalId !== submitted.approvalId)
        throw new AppError("INTERNAL", { message: "广告取消提交伴随缺少本次预锁事实" });
      // 只重入早阶段持有的工单锁；自动批准前保留真实员工身份。
      await submissionCompanion.afterCreated(tx, target);
    }
    const values = await paramsAt(tx, ["refund.points.auto_approve_before_production"], now);
    if (
      values["refund.points.auto_approve_before_production"] === true &&
      l.mode === "release" &&
      l.preview.backToOriginal === l.refundPoints &&
      !l.preview.convertedToAddon &&
      !l.preview.forfeited
    ) {
      const c = cancelCall(tx);
      c.auto = true;
      c.actor = {
        ctx: createIdentityContext({ actor: { type: "system", job: "cancel.auto_execute" } }),
      };
      await deps.approval.approve(tx, c.actor.ctx, { approvalId: submitted.approvalId });
      await deps.approval.recordExecuted(tx, c.actor.ctx, {
        approvalId: submitted.approvalId,
        domain: { type: "cancel_request", id: requestId },
      });
    }
    return cancelResult(tx, requestId);
  });
}
export async function approveAdCancel(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelApproveBody,
) {
  const body = CancelApproveBodySchema.parse(input),
    staff = staffIdentity(actor);
  assertPermission(staff, "finance.refund.approve", deps.clock.now());
  const r = await lockedRequest(tx, actor, id);
  if (actor.ctx.actor.type !== "system") await staffActor(tx, actor);
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    // Generic approval preserves pending/self/version guards before the kind's echo/revalidation.
    await deps.approval.approve(tx, actor.ctx, {
      approvalId: r.approvalRequestId,
      staff,
      lockVersion: body.lockVersion,
      confirmChecks: body.confirmChecks,
      args: body,
    });
    return cancelResult(tx, id);
  });
}
export async function rejectAdCancel(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelRejectBody,
) {
  const body = CancelRejectBodySchema.parse(input),
    staff = staffIdentity(actor);
  assertPermission(staff, "finance.refund.approve", deps.clock.now(), { skipStepUp: true });
  const r = await lockedRequest(tx, actor, id);
  if (actor.ctx.actor.type !== "system") await staffActor(tx, actor);
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await deps.approval.reject(tx, actor.ctx, { approvalId: r.approvalRequestId, staff, ...body });
    return cancelResult(tx, id);
  });
}
export async function withdrawAdCancel(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelWithdrawBody,
) {
  const body = CancelWithdrawBodySchema.parse(input);
  if (actor.ctx.actor.type !== "system") staffIdentity(actor);
  const r = await lockedRequest(tx, actor, id);
  if (actor.ctx.actor.type !== "system") await staffActor(tx, actor);
  if (actor.ctx.actor.type === "system") {
    if (!(await invalidTarget(tx, r))) throw new AppError("APPROVAL_WITHDRAW_FORBIDDEN");
  } else if (actor.staff!.staff.id !== r.approvalRequest.requesterStaffId)
    assertStepUp(actor.staff!, "finance.refund.approve", deps.clock.now());
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await deps.approval.withdraw(tx, actor.ctx, {
      approvalId: r.approvalRequestId,
      staff: actor.staff,
      ...body,
    });
    return cancelResult(tx, id);
  });
}
export async function voidAdCancel(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelVoidBody,
) {
  const body = CancelVoidBodySchema.parse(input);
  if (actor.ctx.actor.type !== "system") {
    const staff = staffIdentity(actor);
    assertPermission(staff, "order.refund.request", deps.clock.now());
  }
  const r = await lockedRequest(tx, actor, id);
  if (actor.ctx.actor.type !== "system") await staffActor(tx, actor);
  if (r.status !== "pending_execution" || r.closedAt || r.approvalRequest.status !== "approved")
    throw new AppError("STATE_NOT_ALLOWED");
  if (
    actor.ctx.actor.type === "system"
      ? !(await invalidTarget(tx, r))
      : actor.staff!.staff.id !== r.approvalRequest.requesterStaffId
  )
    throw new AppError("PERMISSION_DENIED");
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await closeAdCancel(tx, r, "voided", body.note);
    return cancelResult(tx, id);
  });
}
export async function executeCancel(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
  input: CancelExecuteBody,
) {
  const body = CancelExecuteBodySchema.parse(input),
    staff = staffIdentity(actor);
  assertPermission(staff, "finance.refund.execute", deps.clock.now());
  await readCancelExecutionRequest(tx, actor, id);
  const graph = await readCancelExecutionGraph(tx, id);
  await prelockCancelExecutionGraph(tx, graph, staff.staff.id);
  const r = await readCancelExecutionRequest(tx, actor, id);
  if (actor.ctx.actor.type !== "system") await staffActor(tx, actor);
  assertConfirm(body.confirm, {
    requestNo: r.approvalRequest.requestNo!,
    totalRefundPoints: r.totalRefundPoints,
  });
  if (r.status === "done") return cancelResult(tx, id); // serialized replay; no ledger/event duplication
  if (r.status !== "pending_execution" || r.closedAt || r.approvalRequest.status !== "approved")
    throw new AppError("STATE_NOT_ALLOWED");
  const at = (await deps.ledger.lockAccount(tx, r.entityId)).now;
  const values = await paramsAt(tx, ["refund.require_distinct_executor"], at);
  if (
    values["refund.require_distinct_executor"] === true &&
    r.approvalRequest.decidedByStaffId === staff.staff.id
  )
    throw new AppError("REFUND_EXECUTOR_CONFLICT");
  const entry = await revalidateCancel(
    tx,
    { scope: staff.scope, requestId: id, phase: "execute" },
    at,
  );
  if (!entry.ok) throw new CancelRecheckError(id, "execute", entry);
  return withCancelCall(tx, { deps, actor, requestId: id }, async () => {
    await tx.cancelRequest.update({
      where: { id },
      data: {
        recheckLog: { ...jsonObject(r.recheckLog), execute: entry } as Prisma.InputJsonValue,
      },
    });
    await finishCancelTargets(tx, deps, actor, r, graph, at);
    await deps.timers.cancel(tx, {
      subject: { type: "approval_request", id: r.approvalRequestId },
      kinds: ["sla.breach"],
      keyPrefix: executionKey(r.approvalRequestId),
    });
    await transition(
      tx,
      r,
      "cancel.execute",
      {
        executed_at: at,
        closed_at: at,
        is_executed_by_system: false,
        executed_by_staff_id: staff.staff.id,
        exec_confirm_checks: [...body.confirmChecks],
      },
      "cancel.executed",
      { isAutoExecuted: false },
    );
    await deps.approval.recordExecuted(tx, actor.ctx, {
      approvalId: r.approvalRequestId,
      domain: { type: "cancel_request", id: r.id },
    });
    return cancelResult(tx, id);
  });
}
function cancelResult(tx: Tx, id: string) {
  return tx.cancelRequest.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      approvalRequestId: true,
      status: true,
      lockVersion: true,
      totalRefundPoints: true,
      execDueAt: true,
      executedAt: true,
      approvalRequest: { select: { requestNo: true, lockVersion: true } },
      cancelRequestLines: {
        select: { returnedPoints: true, convertedPoints: true, forfeitedPoints: true },
      },
    },
  });
}
/** Use-case facade persists failed rechecks only after the business transaction has really rolled back.
 * Same-Tx callers use the exported Tx functions and retain responsibility for this separate failure log.
 */
export function createAdCancel(deps: CancelDeps) {
  const run = <T>(fn: (tx: Tx) => Promise<T>, idem?: IdempotencyContext) =>
    runCancelUseCase(deps, fn, idem);
  return {
    submit: (
      actor: CancelActor,
      adId: string,
      body: AdCancelCoreSubmitBody,
      idem?: IdempotencyContext,
      companion?: AdCancelSubmissionCompanion,
    ) => run((tx) => submitAdCancel(tx, deps, actor, adId, body, companion), idem),
    approve: (actor: CancelActor, id: string, body: CancelApproveBody, idem?: IdempotencyContext) =>
      run((tx) => approveAdCancel(tx, deps, actor, id, body), idem),
    reject: (actor: CancelActor, id: string, body: CancelRejectBody, idem?: IdempotencyContext) =>
      run((tx) => rejectAdCancel(tx, deps, actor, id, body), idem),
    withdraw: (
      actor: CancelActor,
      id: string,
      body: CancelWithdrawBody,
      idem?: IdempotencyContext,
    ) => run((tx) => withdrawAdCancel(tx, deps, actor, id, body), idem),
    void: (actor: CancelActor, id: string, body: CancelVoidBody, idem?: IdempotencyContext) =>
      run((tx) => voidAdCancel(tx, deps, actor, id, body), idem),
    execute: (actor: CancelActor, id: string, body: CancelExecuteBody, idem?: IdempotencyContext) =>
      run((tx) => executeCancel(tx, deps, actor, id, body), idem),
  };
}
