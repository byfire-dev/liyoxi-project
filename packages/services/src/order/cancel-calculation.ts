import type { CancelBlockReason, CancelQuoteLine, CancelReason } from "@liyoxi/contract";
import { divRoundHalfUp } from "@liyoxi/shared/pricing";
import { calendarDate, diffDays, isLocalDate } from "@liyoxi/shared/time";
import { AppError } from "../kernel/index.js";

type Stage = CancelQuoteLine["stage"];
export interface CancelCalculationInput {
  targetType: "order_item" | "ad";
  state: string;
  step: string | null;
  returnedFrom?: string | null;
  chargePoints: number;
  priorRequestedPoints: number;
  reasonCode: CancelReason;
  ratios: {
    planConfirm?: number | null;
    adAndSample?: number | null;
    samplePending?: number | null;
    postSample?: number | null;
    adInProduction?: number | null;
  };
  usageStartDate?: string | null;
  usageEndDate?: string;
  usageEndSource?: string;
  terminationDate?: string;
  manualDeduct?: { deductPoints: number; deductNote: string };
  at: Date;
}
const stageByStep: Record<string, Stage> = {
  assigning: "plan_confirm",
  plan_confirm: "plan_confirm",
  ad_prep: "ad_and_sample",
  sample_making: "ad_and_sample",
  sample_confirm: "sample_pending",
  batch_compose: "post_sample",
  delivering: "post_sample",
  awaiting_launch: "post_sample",
  launch_verify: "post_sample",
};
const ratioKey = {
  plan_confirm: "planConfirm",
  ad_and_sample: "adAndSample",
  sample_pending: "samplePending",
  post_sample: "postSample",
  ad_in_production: "adInProduction",
} as const;
export const cancelReasonClass = (reason: CancelReason): CancelQuoteLine["reasonClass"] =>
  reason === "platform_fault"
    ? "platform"
    : reason === "qualification_final"
      ? "qualification"
      : "merchant";
const invalid = (reason: CancelBlockReason) => ({ blocker: reason }) as const;
function requireFact(ok: boolean) {
  if (!ok) throw new AppError("PRECONDITION_CHANGED", { message: "取消核算事实无效" });
}
type Amount = Pick<
  CancelQuoteLine,
  | "mode"
  | "stage"
  | "ratioBp"
  | "isManualDeduct"
  | "deductPoints"
  | "deductNote"
  | "refundPoints"
  | "terminationDate"
  | "usageStartDate"
  | "usageEndDate"
  | "usageEndSource"
  | "reasonClass"
>;
/** a05 §3.6/3.61；只算数量，实际去向由 billing.previewReturn 决定。 */
export function calculateCancelLine(
  i: CancelCalculationInput,
): Amount | { blocker: CancelBlockReason } {
  const S = i.chargePoints,
    prior = i.priorRequestedPoints,
    remaining = S - prior;
  requireFact(
    Number.isSafeInteger(S) &&
      S > 0 &&
      Number.isSafeInteger(prior) &&
      prior >= 0 &&
      remaining >= 0 &&
      Number.isFinite(i.at.getTime()),
  );
  let stage: Stage;
  if (i.targetType === "ad") {
    if (i.state === "confirmed") return invalid("ad_confirmed");
    if (i.state === "cancelled") return invalid("ad_cancelled");
    if (i.state === "returned")
      requireFact(i.returnedFrom === "pending_assign" || i.returnedFrom === "producing");
    stage =
      i.state === "pending_assign" ||
      (i.state === "returned" && i.returnedFrom === "pending_assign")
        ? "ad_unassigned"
        : "ad_in_production";
    requireFact(
      ["pending_assign", "returned", "producing", "revising", "pending_confirm"].includes(i.state),
    );
  } else {
    if (["cancelled", "refunded", "terminated", "ended"].includes(i.state))
      return invalid("item_closed");
    if (i.state === "pending_start") {
      requireFact(i.step === null);
      stage = "pending_start";
    } else if (i.state === "live") {
      if (i.reasonCode !== "platform_fault") return invalid("live_not_refundable");
      requireFact(i.step === "in_service" || i.step === "takedown");
      stage = "live";
    } else {
      requireFact(i.state === "producing" || i.state === "to_launch");
      if (i.step === "takedown") return invalid("item_expired");
      requireFact(i.step !== null && stageByStep[i.step] !== undefined);
      stage = stageByStep[i.step!]!;
    }
  }
  const release = stage === "pending_start" || stage === "ad_unassigned";
  // qualification_cancel 的候选严格只有开工前；不能把资格原因套到已生产项目。
  requireFact(i.reasonCode !== "qualification_final" || release);
  let deductPoints = 0,
    refundPoints = remaining,
    ratioBp: number | null = null;
  let isManualDeduct = false,
    deductNote: string | null = null;
  let terminationDate: string | null = null;
  if (release) requireFact(prior === 0);
  else if (stage === "live") {
    const start = i.usageStartDate,
      end = i.usageEndDate;
    terminationDate = i.terminationDate ?? calendarDate(i.at);
    requireFact(!!start && !!end && isLocalDate(start) && isLocalDate(end) && start <= end);
    if (
      !isLocalDate(terminationDate) ||
      terminationDate < start! ||
      terminationDate > end! ||
      terminationDate > calendarDate(i.at)
    )
      throw new AppError("VALIDATION_FAILED");
    requireFact(["license", "early_end", "expired"].includes(i.usageEndSource ?? ""));
    refundPoints = Math.min(
      remaining,
      divRoundHalfUp([S, diffDays(end!, terminationDate)], [diffDays(end!, start!) + 1]),
    );
    deductPoints = remaining - refundPoints;
  } else {
    const key = ratioKey[stage as keyof typeof ratioKey];
    const snapshotRatio = i.ratios[key];
    if (i.reasonCode === "platform_fault") ratioBp = 0;
    else if (stage === "post_sample" && snapshotRatio === null) {
      isManualDeduct = true;
      if (i.manualDeduct) {
        deductPoints = i.manualDeduct.deductPoints;
        deductNote = i.manualDeduct.deductNote.trim();
        if (
          !Number.isSafeInteger(deductPoints) ||
          deductPoints < 0 ||
          deductPoints > remaining ||
          !deductNote ||
          deductNote.length > 200
        )
          throw new AppError("VALIDATION_FAILED");
      }
    } else {
      requireFact(
        Number.isSafeInteger(snapshotRatio) && snapshotRatio! >= 0 && snapshotRatio! <= 10000,
      );
      ratioBp = snapshotRatio!;
    }
    if (ratioBp !== null) deductPoints = Math.min(remaining, divRoundHalfUp([S, ratioBp], [10000]));
    refundPoints = remaining - deductPoints;
  }
  return {
    mode: release ? "release" : refundPoints > 0 ? "refund" : "terminate_only",
    stage,
    ratioBp,
    isManualDeduct,
    deductPoints,
    deductNote,
    refundPoints,
    terminationDate,
    usageStartDate: stage === "live" ? i.usageStartDate! : null,
    usageEndDate: stage === "live" ? i.usageEndDate! : null,
    usageEndSource: stage === "live" ? (i.usageEndSource as Amount["usageEndSource"]) : null,
    reasonClass: cancelReasonClass(i.reasonCode),
  };
}
