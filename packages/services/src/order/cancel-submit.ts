import { OrderCancelRequestCreateBodySchema } from "@liyoxi/contract";
import type { CancelQuote, CancelQuoteLine, OrderCancelRequestCreateBody } from "@liyoxi/contract";
import {
  claimAdCancelRequest,
  readAdCancelFacts,
  readQualificationCancelAds,
} from "../ad/index.js";
import { paramsAt } from "../config/index.js";
import { holdCancelReviewPauses, readCancelReviewHoldTargets } from "../delivery/index.js";
import { AppError, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { readOrderQualificationRound } from "../profile/index.js";
import { cancelCall, cancelPass, cancelScope, withCancelCall } from "./cancel-context.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import { checkCancelStaff, requireCancelPermission } from "./cancel-identity.js";
import {
  adCancelFacts,
  calculateCancelFacts,
  orderCancelFacts,
  quoteOrderCancel,
} from "./cancel-quote.js";
import {
  cancelIds,
  prelockCancelSubmission,
  readCancelSubmissionGraph,
  reserveCancelSubmission,
  scopedCancelOrder,
} from "./cancel-request-locks.js";
import { deriveOrder } from "./rederive.js";
import {
  lockQualificationGraph,
  qualificationSubmissionGraph,
  readQualificationGraph,
  rememberQualificationGraph,
} from "./qualification-locks.js";

const date = (value: string | null) => (value === null ? null : new Date(value));
export const autoEligible = (q: CancelQuote) =>
  q.lines.length > 0 &&
  q.lines.every(
    (l) =>
      l.mode === "release" &&
      l.preview.qty === l.refundPoints &&
      l.preview.backToOriginal === l.refundPoints &&
      !l.preview.convertedToAddon &&
      !l.preview.forfeited,
  );

export async function validateOrderCancelSubmission(
  tx: Tx,
  orderId: string,
  input: unknown,
  approvalId: string,
) {
  const body = OrderCancelRequestCreateBodySchema.parse(input),
    c = cancelCall(tx);
  const order = await scopedCancelOrder(tx, cancelScope(c.actor), orderId);
  const graph = await readCancelSubmissionGraph(tx, { ...order, orderIds: [order.id], adIds: [] });
  if (graph.delivery.staffIds.some((id) => !c.prelockedStaffIds?.includes(id)))
    throw new AppError("PRECONDITION_CHANGED", { message: "取消申请员工锁图已变化" });
  c.lineIds = new Map(graph.items.map((item) => [item.id, uuidv7()]));
  await reserveCancelSubmission(tx, {
    approvalId,
    requestId: c.requestId!,
    lineIds: [...c.lineIds.values()],
    approvalIds: graph.delivery.approvalRequestIds,
  });
  if (c.orderSubmissionCompanion) {
    c.orderSubmissionTarget = Object.freeze({
      actor: c.actor,
      approvalId,
      dramaOrderId: order.id,
      entityId: order.entityId,
      storeId: order.storeId,
    });
  }
  await prelockCancelSubmission(
    tx,
    graph,
    c.orderSubmissionCompanion
      ? () => c.orderSubmissionCompanion!.beforeAccount(tx, c.orderSubmissionTarget!)
      : undefined,
  );
  const at = (await c.deps.ledger.lockAccount(tx, order.entityId)).now;
  const quoteBody = {
    reasonCode: body.reasonCode,
    ...(body.orderItemIds === undefined ? {} : { orderItemIds: body.orderItemIds }),
    ...(body.terminationDate === undefined ? {} : { terminationDate: body.terminationDate }),
    ...(body.manualDeducts === undefined ? {} : { manualDeducts: body.manualDeducts }),
  };
  const q = await quoteOrderCancel(
    tx,
    { scope: cancelScope(c.actor), orderId, body: quoteBody },
    at,
  );
  if (!q.lines.length || (body.orderItemIds !== undefined && q.blockers.length > 0))
    throw new AppError("CANCEL_ITEM_NOT_ALLOWED", { details: { lines: q.blockers } });
  if (
    q.lines.some(
      (l) => l.isManualDeduct && !body.manualDeducts?.some((d) => d.orderItemId === l.targetId),
    )
  )
    throw new AppError("VALIDATION_FAILED", {
      message: "请为每个需人工核算的订单项填写扣除数与依据",
    });
  if (q.totalRefundPoints !== body.expect.totalRefundPoints)
    throw new AppError("CANCEL_QUOTE_CHANGED", { details: { quote: q } });
  c.quote = q;
}

async function insertRequest(
  tx: Tx,
  input: {
    kind: "order_cancel" | "qualification_cancel";
    approvalId: string;
    entityId: string;
    storeId: string;
    orderId?: string;
    reasonCode: string;
    note: string;
  },
) {
  const c = cancelCall(tx),
    q = c.quote!,
    at = new Date(q.quotedAt);
  await tx.cancelRequest.create({
    data: {
      id: c.requestId!,
      approvalRequestId: input.approvalId,
      kind: input.kind,
      entityId: input.entityId,
      storeId: input.storeId,
      dramaOrderId: input.orderId ?? null,
      reasonCode: input.reasonCode,
      note: input.note,
      lineCount: q.lines.length,
      totalBasePoints: q.totalBasePoints,
      totalDeductPoints: q.totalDeductPoints,
      totalRefundPoints: q.totalRefundPoints,
      status: "pending_approval",
      createdAt: at,
      updatedAt: at,
    },
  });
  for (const line of q.lines)
    await tx.cancelRequestLine.create({
      data: {
        id: c.lineIds!.get(line.targetId)!,
        cancelRequestId: c.requestId!,
        entityId: input.entityId,
        storeId: input.storeId,
        targetType: line.targetType,
        targetId: line.targetId,
        pointHoldId:
          line.targetType === "order_item"
            ? (await tx.orderItem.findUniqueOrThrow({ where: { id: line.targetId } })).pointHoldId
            : (await readAdCancelFacts(tx, line.targetId))!.pointHoldId,
        mode: line.mode,
        stage: line.stage,
        stepAtSubmit: line.stepAtSubmit,
        reasonClass: line.reasonClass,
        chargePoints: line.chargePoints,
        priorRequestedPoints: line.priorRequestedPoints,
        ratioBp: line.ratioBp,
        deductPoints: line.deductPoints,
        deductNote: line.deductNote,
        refundPoints: line.refundPoints,
        terminationDate: date(line.terminationDate),
        usageStartDate: date(line.usageStartDate),
        usageEndDate: date(line.usageEndDate),
        usageEndSource: line.usageEndSource,
        previewSnapshot: line.preview,
        createdAt: at,
      },
    });
  await c.deps.flow.transition(tx, c.actor.ctx, {
    machine: "cancel_request",
    stateField: "status",
    id: c.requestId!,
    event: "cancel.submit",
    created: true,
    entityId: input.entityId,
    storeId: input.storeId,
    args: cancelPass(),
    audit: { mergedInto: { approvalRequestId: input.approvalId } },
    emit: {
      type: "cancel.submitted",
      payload: {
        v: 1,
        cancelRequestId: c.requestId!,
        approvalRequestId: input.approvalId,
        kind: input.kind,
        subjectType: input.kind === "order_cancel" ? "drama_order" : "store",
        subjectId: input.orderId ?? input.storeId,
        totalRefundPoints: q.totalRefundPoints,
      },
    },
  });
  const values = await paramsAt(tx, ["refund.points.auto_approve_before_production"], at);
  const automatic =
    values["refund.points.auto_approve_before_production"] === true && autoEligible(q);
  const items = await tx.orderItem.findMany({
    where: {
      id: { in: q.lines.filter((l) => l.targetType === "order_item").map((l) => l.targetId) },
    },
    select: { dramaOrderId: true },
  });
  for (const orderId of cancelIds(items.map((i) => i.dramaOrderId)))
    await deriveOrder(
      tx,
      { assembly: c.deps.assembly!, flow: c.deps.flow, clock: c.deps.clock },
      orderId,
      { openedCancelRequestId: c.requestId!, suppressEvent: automatic },
    );
  for (const line of q.lines.filter((l) => l.targetType === "ad"))
    await claimAdCancelRequest(tx, {
      adId: line.targetId,
      entityId: input.entityId,
      storeId: input.storeId,
      cancelRequestId: c.requestId!,
      now: at,
    });
  if (items.length) {
    if (!c.deps.assembly) throw new AppError("INTERNAL", { message: "取消暂停缺少真实履约装配" });
    const targets = await readCancelReviewHoldTargets(tx, c.deps.assembly, input.approvalId);
    await holdCancelReviewPauses(
      tx,
      { ...c.deps, assembly: c.deps.assembly },
      c.actor.ctx,
      targets,
    );
  }
  if (c.orderSubmissionCompanion)
    await c.orderSubmissionCompanion.afterCreated(tx, c.orderSubmissionTarget!);
  if (automatic) {
    c.auto = true;
    c.actor = {
      ctx: createIdentityContext({ actor: { type: "system", job: "cancel.auto_execute" } }),
    };
    await c.deps.approval.approve(tx, c.actor.ctx, { approvalId: input.approvalId });
  }
  return c.requestId!;
}

export async function createOrderCancelRequest(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  orderId: string,
  input: OrderCancelRequestCreateBody,
  idempotencyKey?: string | null,
) {
  const body = OrderCancelRequestCreateBodySchema.parse(input);
  const staff = requireCancelPermission(deps, actor, "order.refund.request");
  const order = await scopedCancelOrder(tx, cancelScope(actor), orderId);
  const graph = await readCancelSubmissionGraph(tx, { ...order, orderIds: [order.id], adIds: [] });
  const prelockedStaffIds = cancelIds([...graph.delivery.staffIds, staff.staff.id]);
  await lockRows(tx, "staff", prelockedStaffIds, "share");
  await checkCancelStaff(tx, actor, true);
  const companion = body.serviceTicketId
    ? deps.orderSubmissionCompanion?.(body.serviceTicketId)
    : undefined;
  if (body.serviceTicketId && !companion)
    throw new AppError("INTERNAL", { message: "取消申请缺少客服关联公口" });
  return withCancelCall(
    tx,
    {
      deps,
      actor,
      requestId: uuidv7(),
      prelockedStaffIds,
      ...(companion ? { orderSubmissionCompanion: companion } : {}),
    },
    async () => {
      const submitted = await deps.approval.submit(tx, actor.ctx, {
        kind: "order_cancel",
        subjectType: "drama_order",
        subjectId: orderId,
        entityId: order.entityId,
        storeId: order.storeId,
        input: body,
        idempotencyKey,
      });
      return insertRequest(tx, {
        kind: "order_cancel",
        approvalId: submitted.approvalId,
        entityId: order.entityId,
        storeId: order.storeId,
        orderId,
        reasonCode: body.reasonCode,
        note: body.note,
      });
    },
  );
}

export interface QualificationCancelSubmission {
  readonly entityId: string;
  readonly storeId: string;
  readonly requesterStaffId: string | null;
  readonly submissionId: string;
  readonly roundNo: number;
}
/** Caller owns the stable qualification event/round and the complete pre-account lock graph. */
export async function submitQualificationCancel(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  input: QualificationCancelSubmission,
) {
  const graph = await readQualificationGraph(tx, input);
  rememberQualificationGraph(tx, graph);
  await lockRows(tx, "staff", graph.staffIds, "share");
  return withCancelCall(
    tx,
    { deps, actor, requestId: uuidv7(), prelockedStaffIds: graph.staffIds },
    async () => {
      const submitted = await deps.approval.submit(tx, actor.ctx, {
        kind: "qualification_cancel",
        subjectType: "store",
        subjectId: input.storeId,
        entityId: input.entityId,
        storeId: input.storeId,
        requesterStaffId: input.requesterStaffId,
        input,
      });
      return insertRequest(tx, {
        ...input,
        kind: "qualification_cancel",
        approvalId: submitted.approvalId,
        reasonCode: "qualification_final",
        note: "门店资质终局驳回，取消待开工订购与未指派广告",
      });
    },
  );
}

export async function validateQualificationCancelSubmission(
  tx: Tx,
  input: QualificationCancelSubmission,
  approvalId: string,
) {
  const c = cancelCall(tx);
  if (
    c.actor.ctx.actor.type !== "system" ||
    c.actor.ctx.actor.job !== "order.qualification_decided"
  )
    throw new AppError("PERMISSION_DENIED");
  const plan = qualificationSubmissionGraph(tx);
  c.lineIds = new Map(
    [...plan.graph.items.map((i) => i.id), ...plan.adIds].map((id) => [id, uuidv7()]),
  );
  await lockQualificationGraph(tx, plan, {
    approvalId,
    requestId: c.requestId!,
    lineIds: [...c.lineIds.values()],
  });
  const scope = { entityId: input.entityId, storeId: input.storeId };
  const round = await readOrderQualificationRound(tx, scope);
  const store = await tx.store.findFirst({
    where: { id: input.storeId, entityId: input.entityId },
    include: { entity: true },
  });
  if (
    !round ||
    round.submissionId !== input.submissionId ||
    round.roundNo !== input.roundNo ||
    round.approvalStatus !== "rejected" ||
    round.outcome !== "rejected" ||
    !round.finalRejectedAt ||
    round.decidedByStaffId !== input.requesterStaffId ||
    !store ||
    store.lifecycle !== "active" ||
    store.entity.lifecycle !== "active" ||
    store.qualificationStatus !== "rejected" ||
    plan.requests.some((r) => r.kind === "qualification_cancel")
  )
    throw new AppError("PRECONDITION_CHANGED");
  const at = (await c.deps.ledger.lockAccount(tx, input.entityId)).now;
  const lines: CancelQuoteLine[] = [];
  for (const item of await tx.orderItem.findMany({
    where: { dramaOrderId: { in: plan.orderIds } },
    orderBy: { id: "asc" },
  })) {
    const result = await calculateCancelFacts(
      tx,
      await orderCancelFacts(tx, item),
      "qualification_final",
      at,
    );
    if ("blocker" in result || result.mode !== "release")
      throw new AppError("PRECONDITION_CHANGED");
    lines.push(result);
  }
  for (const ad of await readQualificationCancelAds(tx, scope)) {
    const result = await calculateCancelFacts(tx, adCancelFacts(ad), "qualification_final", at);
    if ("blocker" in result || result.mode !== "release")
      throw new AppError("PRECONDITION_CHANGED");
    lines.push(result);
  }
  if (!lines.length) throw new AppError("PRECONDITION_CHANGED");
  const total = lines.reduce((n, l) => n + l.refundPoints, 0);
  c.quote = {
    quotedAt: at.toISOString(),
    reasonCode: "qualification_final",
    lines,
    totalBasePoints: total,
    totalDeductPoints: 0,
    totalRefundPoints: total,
    destination: {
      qty: total,
      backToOriginal: lines.reduce((n, l) => n + l.preview.backToOriginal, 0),
      convertedToAddon: lines.reduce((n, l) => n + l.preview.convertedToAddon, 0),
      forfeited: lines.reduce((n, l) => n + l.preview.forfeited, 0),
      lots: lines.flatMap((l) => l.preview.lots),
    },
    needsManualDeduct: false,
    blockers: [],
    expect: { totalRefundPoints: total },
  };
}
