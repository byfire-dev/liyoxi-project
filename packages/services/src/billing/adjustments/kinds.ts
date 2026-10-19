import {
  PointAdjustmentInputSchema,
  PointAdjustmentApproveBodySchema,
  TermExtensionApproveBodySchema,
} from "@liyoxi/contract";
import { z } from "zod";
import { defineApprovalKind } from "../../approval/index.js";
import type { ApprovalRow, ApprovalSubmission } from "../../approval/index.js";
import { AppError, createIdentityContext } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { fromDateColumn, toDateColumn } from "../ledger/context.js";
import { isRefundPending } from "../ledger/operation.js";
import type { BillingAdjustmentDeps } from "./context.js";
import type {
  PointAdjustmentRequestCreateBody,
  TermExtensionRequestCreateBody,
} from "@liyoxi/contract";
import { adjustmentQuote, assertAdjustmentQuote, adjustmentReasons } from "./quotes.js";

export interface AdjustmentSubmission {
  readonly id: string;
  readonly body: PointAdjustmentRequestCreateBody;
}
export interface ExtensionSubmission {
  readonly id: string;
  readonly body: TermExtensionRequestCreateBody;
}
async function adjustmentRow(tx: Tx, row: ApprovalRow) {
  const found = await tx.pointAdjustmentRequest.findUnique({
    where: { approvalRequestId: row.id },
  });
  if (
    !found ||
    row.kind !== "points_adjust" ||
    row.subjectType !== "billing_account" ||
    row.subjectId !== found.entityId ||
    row.entityId !== found.entityId ||
    found.appliedAt
  )
    throw new AppError("PRECONDITION_CHANGED");
  return found;
}
async function extensionRow(tx: Tx, row: ApprovalRow) {
  const found = await tx.termExtensionRequest.findUnique({ where: { approvalRequestId: row.id } });
  if (
    !found ||
    row.kind !== "subscription_extend" ||
    row.subjectType !== "subscription_term" ||
    row.subjectId !== found.subscriptionTermId ||
    row.entityId !== found.entityId ||
    found.appliedAt
  )
    throw new AppError("PRECONDITION_CHANGED");
  return found;
}
async function validateAdjustment(
  tx: Tx,
  deps: BillingAdjustmentDeps,
  s: ApprovalSubmission<AdjustmentSubmission>,
) {
  const b = s.input.body;
  if (
    b.pointAccountId !== s.entityId ||
    s.subjectId !== s.entityId ||
    s.subjectType !== "billing_account"
  )
    throw new AppError("VALIDATION_FAILED");
  const quote = await adjustmentQuote(tx, b.pointAccountId, b, deps.clock.now());
  if (quote.spendableBeforePoints !== b.confirm.spendableBeforePoints)
    throw new AppError("CONFIRM_MISMATCH");
  // 在途去重由公共submit给出准确在审单号，其余业务前提在提交时检查。
  assertAdjustmentQuote({
    ...quote,
    blockReasons: quote.blockReasons.filter((reason) => reason !== "pending_exists"),
  });
  if (
    b.storeId &&
    !(await tx.store.findFirst({
      where: { id: b.storeId, entityId: b.pointAccountId },
      select: { id: true },
    }))
  )
    throw new AppError("VALIDATION_FAILED");
  if (
    b.termExtensionRequestId &&
    !(await tx.termExtensionRequest.findFirst({
      where: {
        id: b.termExtensionRequestId,
        entityId: b.pointAccountId,
        appliedAt: { not: null },
        approvalRequest: { status: "approved" },
      },
      select: { id: true },
    }))
  )
    throw new AppError("VALIDATION_FAILED");
  if (b.serviceTicketId)
    await deps.refs.prepare(tx, { serviceTicketId: b.serviceTicketId, entityId: b.pointAccountId });
}

export function createAdjustmentKinds(current: () => BillingAdjustmentDeps) {
  const points = defineApprovalKind<AdjustmentSubmission>({
    category: "approval",
    domain: { table: "point_adjustment_request", column: "approval_request_id" },
    viewModules: ["billing", "finance"],
    decidePermission: "billing.adjust.approve",
    groupBound: false,
    hasExecution: false,
    numberPrefix: "TZ",
    dedupeKey: (s) => `points_adjust:${s.entityId}`,
    operations: {
      get: "admin.pointAdjustmentRequest.get",
      approve: "admin.pointAdjustmentRequest.approve",
      reject: "admin.pointAdjustmentRequest.reject",
      withdraw: "admin.pointAdjustmentRequest.withdraw",
    },
    validate: (tx, s) => validateAdjustment(tx, current(), s),
    summarize: async (tx, s) => {
      const b = s.input.body,
        sign = b.direction === "increase" ? 1 : -1,
        hold = b.pointHoldId
          ? await tx.pointHold.findUnique({ where: { id: b.pointHoldId } })
          : null;
      return {
        title: `积分调整 ${sign > 0 ? "+" : "−"}${b.adjustPoints}（${b.lotKind === "plan" ? "套餐积分" : "加购积分"}）`,
        points: sign * b.adjustPoints,
        lines: [
          { label: "原因", value: adjustmentReasons[b.reasonCode] },
          {
            label: "可用积分",
            value: `${b.confirm.spendableBeforePoints} → ${Math.max(0, b.confirm.spendableBeforePoints + sign * b.adjustPoints)}`,
          },
          ...(hold?.groupRef ? [{ label: "关联单号", value: hold.groupRef }] : []),
        ],
        domain: { type: "point_adjustment_request", id: s.input.id },
      };
    },
    revalidate: async (tx, row, args) => {
      const request = await adjustmentRow(tx, row),
        body = PointAdjustmentApproveBodySchema.parse(args);
      if (
        body.confirm.requestNo !== row.requestNo ||
        body.confirm.direction !== request.direction ||
        body.confirm.adjustPoints !== request.adjustPoints
      )
        throw new AppError("CONFIRM_MISMATCH");
      const clock = await current().ledger.lockAccount(tx, request.entityId);
      const quote = await adjustmentQuote(
        tx,
        request.entityId,
        {
          direction: request.direction === "increase" ? "increase" : "decrease",
          lotKind: request.lotKind === "plan" ? "plan" : "addon",
          adjustPoints: request.adjustPoints,
          reasonCode: PointAdjustmentInputSchema.shape.reasonCode.parse(request.reasonCode),
          ...(request.pointHoldId ? { pointHoldId: request.pointHoldId } : {}),
        },
        clock.now,
        row.id,
      );
      assertAdjustmentQuote(quote, true);
    },
    onApproved: async (tx, row, decision) => {
      const deps = current(),
        request = await adjustmentRow(tx, row);
      if (!decision.decidedByStaffId || !row.requestNo) throw new AppError("PRECONDITION_CHANGED");
      const ctx = createIdentityContext({
        actor: { type: "staff", id: decision.decidedByStaffId, client: "admin" },
        entityId: request.entityId,
        storeId: row.storeId,
      });
      const result =
        request.reasonCode === "platform_refund"
          ? await deps.ledger.refund(tx, {
              pointHoldId: request.pointHoldId!,
              qty: request.adjustPoints,
              reasonClass: "platform",
              source: { type: "approval_request", id: row.id, requestNo: row.requestNo },
              refNo:
                (await tx.pointHold.findUniqueOrThrow({ where: { id: request.pointHoldId! } }))
                  .groupRef ?? row.requestNo,
              ctx,
            })
          : await deps.ledger.adjust(tx, {
              entityId: request.entityId,
              approvalRequestId: row.id,
              requestNo: row.requestNo,
              pointAdjustmentRequestId: request.id,
              direction: request.direction === "increase" ? "increase" : "decrease",
              lotKind: request.lotKind === "plan" ? "plan" : "addon",
              points: request.adjustPoints,
              reasonCode: PointAdjustmentInputSchema.shape.reasonCode.parse(request.reasonCode),
              note: request.note,
              ctx,
            });
      const operation = await tx.ledgerOperation.findUniqueOrThrow({
        where: { id: result.operationId },
      });
      await tx.pointAdjustmentRequest.update({
        where: { id: request.id },
        data: {
          ledgerOperationId: operation.id,
          appliedAt: operation.occurredAt,
          updatedAt: operation.occurredAt,
        },
      });
      if (request.reasonCode === "platform_refund" && !result.replayed)
        await deps.events.emit(tx, ctx, {
          type: "billing.points.adjusted",
          aggregate: { type: "billing_account", id: request.entityId },
          payload: {
            v: 1,
            entityId: request.entityId,
            pointAdjustmentRequestId: request.id,
            deltaPoints: request.adjustPoints,
          },
          dedupeKey: `billing.points.adjusted:${row.requestNo}`,
          entityId: request.entityId,
          storeId: null,
        });
    },
    onRejected: async (tx, _row, decision) => {
      for (const code of decision.reasonCodes) {
        const reason = await tx.dictItem.findUnique({
          where: { dictTypeKey_code: { dictTypeKey: "reject_reason", code } },
        });
        if (
          !reason?.isEnabled ||
          !z.object({ scene: z.literal("point_adjust") }).safeParse(reason.ext).success
        )
          throw new AppError("VALIDATION_FAILED");
      }
    },
    onWithdrawn: async () => {},
  });
  const extension = defineApprovalKind<ExtensionSubmission>({
    category: "approval",
    domain: { table: "term_extension_request", column: "approval_request_id" },
    viewModules: ["order", "billing"],
    decidePermission: "billing.extension.approve",
    groupBound: true,
    hasExecution: false,
    numberPrefix: "YQ",
    dedupeKey: (s) => `subscription_extend:${s.entityId}`,
    operations: {
      get: "admin.termExtensionRequest.get",
      approve: "admin.termExtensionRequest.approve",
      reject: "admin.termExtensionRequest.reject",
      withdraw: "admin.termExtensionRequest.withdraw",
    },
    validate: async (tx, s) => {
      const deps = current(),
        b = s.input.body,
        term = await tx.subscriptionTerm.findUnique({ where: { id: b.subscriptionTermId } }),
        at = deps.clock.now();
      if (!term || s.subjectId !== term.id || s.entityId !== term.entityId)
        throw new AppError("NOT_FOUND");
      if (term.status !== "active" || at < term.startsAt || at >= term.endsAt)
        throw new AppError("EXTENSION_NOT_APPLICABLE", { details: { termStatus: term.status } });
      if (await isRefundPending(tx, term.entityId)) throw new AppError("PLAN_REFUND_IN_PROGRESS");
      if (
        b.confirm.subscriptionTermId !== term.id ||
        b.confirm.endDate !== fromDateColumn(term.endDate)
      )
        throw new AppError("CONFIRM_MISMATCH");
      if (
        !(await tx.dictItem.findFirst({
          where: { dictTypeKey: "extend_reason", code: b.reasonCode, isEnabled: true },
          select: { id: true },
        }))
      )
        throw new AppError("VALIDATION_FAILED");
    },
    summarize: async (tx, s) => {
      const b = s.input.body,
        reason = await tx.dictItem.findUniqueOrThrow({
          where: { dictTypeKey_code: { dictTypeKey: "extend_reason", code: b.reasonCode } },
        });
      return {
        title: `补偿延长 ${b.days} 天`,
        lines: [
          { label: "原因", value: reason.name },
          { label: "发起时止日", value: b.confirm.endDate },
        ],
        domain: { type: "term_extension_request", id: s.input.id },
      };
    },
    revalidate: async (tx, row, args) => {
      const request = await extensionRow(tx, row),
        body = TermExtensionApproveBodySchema.parse(args);
      if (body.confirm.requestNo !== row.requestNo || body.confirm.days !== request.days)
        throw new AppError("CONFIRM_MISMATCH");
      await current().ledger.lockAccount(tx, request.entityId);
      if (await isRefundPending(tx, request.entityId))
        throw new AppError("PRECONDITION_CHANGED", { details: { reason: "refund_in_progress" } });
    },
    onApproved: async (tx, row, decision) => {
      const deps = current(),
        request = await extensionRow(tx, row);
      if (!decision.decidedByStaffId || !row.requestNo) throw new AppError("PRECONDITION_CHANGED");
      const ctx = createIdentityContext({
          actor: { type: "staff", id: decision.decidedByStaffId, client: "admin" },
          entityId: request.entityId,
        }),
        account = await tx.billingAccount.findUniqueOrThrow({
          where: { entityId: request.entityId },
        }),
        before = account.currentSubscriptionTermId
          ? await tx.subscriptionTerm.findUniqueOrThrow({
              where: { id: account.currentSubscriptionTermId },
            })
          : null,
        input = {
          entityId: request.entityId,
          approvalRequestId: row.id,
          requestNo: row.requestNo,
          days: request.days,
          ctx,
        },
        result =
          account.subStatus === "active" && before
            ? await deps.ledger.applyExtension(tx, input)
            : await deps.ledger.reviveTerm(tx, {
                ...input,
                subscriptionTermId: request.subscriptionTermId,
                submittedAt: request.createdAt,
              });
      await tx.termExtensionRequest.update({
        where: { id: request.id },
        data: {
          appliedSubscriptionTermId: result.appliedSubscriptionTermId,
          appliedMode: result.appliedMode,
          prevEndDate: toDateColumn(result.prevEndDate),
          newEndDate: toDateColumn(result.newEndDate),
          ledgerOperationId: result.operationId,
          appliedAt: result.appliedAt,
          updatedAt: result.appliedAt,
        },
      });
      if (!result.replayed) {
        const shared = {
          v: 1 as const,
          termId: result.appliedSubscriptionTermId,
          entityId: request.entityId,
          newEndsAt: (
            await tx.subscriptionTerm.findUniqueOrThrow({
              where: { id: result.appliedSubscriptionTermId },
            })
          ).endsAt.toISOString(),
        };
        await deps.events.emit(tx, ctx, {
          type:
            result.appliedMode === "extend"
              ? "billing.subscription.extended"
              : "billing.subscription.resumed",
          aggregate: { type: "subscription_term", id: result.appliedSubscriptionTermId },
          payload:
            result.appliedMode === "extend"
              ? { ...shared, prevEndsAt: before!.endsAt.toISOString() }
              : shared,
          dedupeKey: `billing.subscription.compensation:${row.requestNo}`,
          entityId: request.entityId,
          storeId: null,
        });
      }
    },
    onRejected: async () => {},
    onWithdrawn: async () => {},
  });
  return { points, extension };
}
const unbound = () => {
  throw new TypeError("积分调整/补偿延长运行时尚未绑定");
};
export const unboundAdjustmentKinds = createAdjustmentKinds(unbound);
