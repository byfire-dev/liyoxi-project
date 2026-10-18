import { ExtensionQuoteSchema, PointAdjustmentQuoteSchema } from "@liyoxi/contract";
import type { PointAdjustmentInput } from "@liyoxi/contract";
import { addDays, calendarDate, endOfDay } from "@liyoxi/shared/time";
import { termDates } from "@liyoxi/shared/period";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { previewReturn } from "../ledger/index.js";
import { fromDateColumn } from "../ledger/context.js";
import { getEntitlements, getWalletView } from "../read/index.js";

export const adjustmentReasons = {
  compensation: "制作问题补偿",
  platform_refund: "平台原因退回",
  correction: "纠正错误记录",
  campaign: "运营活动赠送",
  other: "其他",
};
export async function adjustmentQuote(
  tx: Tx,
  entityId: string,
  input: PointAdjustmentInput,
  at: Date,
  ownApprovalId?: string,
) {
  const wallet = await getWalletView(tx, entityId, at),
    p = wallet.points,
    before = input.lotKind === "plan" ? p.planAvailablePoints : p.addonAvailablePoints,
    blockReasons: ("account_inactive" | "insufficient" | "hold_invalid" | "pending_exists")[] = [];
  const hold = input.pointHoldId
    ? await tx.pointHold.findFirst({ where: { id: input.pointHoldId, entityId } })
    : null;
  const available = hold ? hold.qty - hold.returnedQty - hold.forfeitedQty : 0;
  let selectedDelta = input.direction === "increase" ? input.adjustPoints : -input.adjustPoints,
    totalDelta = selectedDelta;
  if (input.reasonCode === "platform_refund") {
    if (
      !hold ||
      !["captured", "refunded_partial"].includes(hold.status) ||
      available < input.adjustPoints
    ) {
      blockReasons.push("hold_invalid");
      selectedDelta = totalDelta = 0;
    } else {
      const preview = await previewReturn(
        tx,
        { holdId: hold.id, qty: input.adjustPoints, reasonClass: "platform" },
        at,
      );
      selectedDelta = preview.lots.reduce(
        (sum, lot) =>
          sum +
          (lot.route === "forfeited"
            ? 0
            : (lot.route === "converted" ? "addon" : lot.lotKind) === input.lotKind
              ? lot.qty
              : 0),
        0,
      );
      totalDelta = preview.backToOriginal + preview.convertedToAddon;
    }
  } else {
    if (wallet.subscription.status !== "active" || wallet.subscription.isRefundPending)
      blockReasons.push("account_inactive");
    if (input.pointHoldId && !hold) blockReasons.push("hold_invalid");
    if (input.direction === "decrease" && before < input.adjustPoints)
      blockReasons.push("insufficient");
  }
  if (
    await tx.approvalRequest.findFirst({
      where: {
        kind: "points_adjust",
        entityId,
        status: "pending",
        ...(ownApprovalId ? { id: { not: ownApprovalId } } : {}),
      },
      select: { id: true },
    })
  )
    blockReasons.push("pending_exists");
  return PointAdjustmentQuoteSchema.parse({
    spendableBeforePoints: p.spendablePoints,
    spendableAfterPoints:
      wallet.subscription.status === "active" && !wallet.subscription.isRefundPending
        ? Math.max(0, p.spendablePoints + totalDelta)
        : 0,
    lotAvailableBefore: before,
    lotAvailableAfter: Math.max(0, before + selectedDelta),
    planPointsExpireAt:
      input.lotKind === "plan" ? (p.planPointsExpireAt?.toISOString() ?? null) : null,
    pointHold: hold
      ? {
          pointHoldId: hold.id,
          groupRef: hold.groupRef,
          qty: hold.qty,
          returnablePoints: available,
          status: hold.status,
        }
      : null,
    isAllowed: blockReasons.length === 0,
    blockReasons,
  });
}

export function assertAdjustmentQuote(
  quote: Awaited<ReturnType<typeof adjustmentQuote>>,
  approval = false,
): void {
  const reason = quote.blockReasons[0];
  if (!reason) return;
  if (approval)
    throw new AppError("PRECONDITION_CHANGED", {
      details: {
        reason:
          reason === "account_inactive"
            ? reason
            : reason === "insufficient"
              ? reason
              : quote.pointHold && quote.pointHold.returnablePoints === 0
                ? "hold_exhausted"
                : "hold_not_captured",
      },
    });
  if (reason === "pending_exists") throw new AppError("APPROVAL_ALREADY_PENDING");
  if (reason === "account_inactive") throw new AppError("ADJUST_ACCOUNT_INACTIVE");
  if (reason === "insufficient")
    throw new AppError("ADJUST_EXCEEDS_AVAILABLE", {
      details: { availablePoints: quote.lotAvailableBefore },
    });
  throw new AppError("ADJUST_HOLD_INVALID", {
    details: {
      holdStatus: quote.pointHold?.status ?? null,
      returnablePoints: quote.pointHold?.returnablePoints ?? 0,
    },
  });
}

export async function extensionQuote(
  tx: Tx,
  entityId: string,
  originalTermId: string,
  days: number,
  at: Date,
  ownApprovalId?: string,
) {
  const entitlements = await getEntitlements(tx, entityId, at),
    all = await tx.subscriptionTerm.findMany({ where: { entityId }, orderBy: { termNo: "asc" } }),
    target = entitlements.term
      ? all.find((row) => row.id === entitlements.term!.termId)
      : all.at(-1),
    blockReasons: ("no_term" | "term_refunded" | "refund_in_progress" | "pending_exists")[] = [];
  if (!target) blockReasons.push("no_term");
  else if (["refunded", "cancelled", "scheduled"].includes(target.status))
    blockReasons.push("term_refunded");
  if (entitlements.refundPending || target?.refundRequestId)
    blockReasons.push("refund_in_progress");
  if (
    await tx.approvalRequest.findFirst({
      where: {
        kind: "subscription_extend",
        entityId,
        status: "pending",
        ...(ownApprovalId ? { id: { not: ownApprovalId } } : {}),
      },
      select: { id: true },
    })
  )
    blockReasons.push("pending_exists");
  const mode =
      !target || blockReasons.length ? "not_applicable" : entitlements.term ? "extend" : "revive",
    prevEndDate = target ? fromDateColumn(target.endDate) : null,
    today = calendarDate(at),
    newEndDate =
      mode === "not_applicable" || !prevEndDate
        ? null
        : addDays(
            mode === "revive" && prevEndDate < addDays(today, -1)
              ? addDays(today, -1)
              : prevEndDate,
            days,
          ),
    shiftedTerms: { subscriptionTermId: string; startDate: string; endDate: string }[] = [];
  let restorePoints = 0;
  if (target && mode === "revive") {
    if (target.status === "ended") {
      const operation = await tx.ledgerOperation.findUnique({
        where: { opKey: `expire:subscription_term:${target.id}:${prevEndDate}` },
        select: { id: true },
      });
      const totals = operation
        ? await tx.pointLedgerEntry.aggregate({
            where: {
              ledgerOperationId: operation.id,
              fromBucket: "available",
              toBucket: "expired",
            },
            _sum: { qty: true },
          })
        : null;
      restorePoints = totals?._sum.qty ?? 0;
    } else {
      const [lots, pending] = await Promise.all([
        tx.pointLot.aggregate({
          where: { entityId, subscriptionTermId: target.id, kind: "plan" },
          _sum: { availableQty: true },
        }),
        tx.grantSchedule.aggregate({
          where: { subscriptionTermId: target.id, status: "pending", dueAt: { lt: target.endsAt } },
          _sum: { points: true },
        }),
      ]);
      restorePoints = (lots._sum.availableQty ?? 0) + (pending._sum.points ?? 0);
    }
  }
  if (mode === "extend" && newEndDate) {
    let previous = newEndDate;
    for (const next of all.filter((row) => row.status === "scheduled")) {
      const dates = termDates(addDays(previous, 1), next.months);
      shiftedTerms.push({
        subscriptionTermId: next.id,
        startDate: dates.startDate,
        endDate: dates.endDate,
      });
      previous = dates.endDate;
    }
  }
  return ExtensionQuoteSchema.parse({
    mode,
    targetSubscriptionTermId: target?.id ?? null,
    isTargetDifferent: !!target && target.id !== originalTermId,
    days,
    prevEndDate,
    newEndDate,
    newEndsAt: newEndDate ? endOfDay(newEndDate).toISOString() : null,
    restorePoints,
    shiftedTerms,
    blockReasons,
  });
}
