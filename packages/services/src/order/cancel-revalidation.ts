import {
  CancelReasonSchema,
  CancelRecheckEntrySchema,
  ReturnBreakdownSchema,
} from "@liyoxi/contract";
import type { CancelQuoteLine, CancelRecheckEntry } from "@liyoxi/contract";
import { readAdCancelFacts } from "../ad/index.js";
import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { readCancelReviewPauseTargets } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import {
  adCancelFacts,
  boundCancelAdItems,
  calculateCancelFacts,
  orderCancelFacts,
} from "./cancel-quote.js";

const date = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
/** Read only. Caller owns scope and, on a write path, the whole stable lock graph documented in README.
 * Does not acquire locks, mutate recheck_log, or turn a failure into an approval decision.
 */
export async function revalidateCancel(
  tx: Tx,
  input: { scope: DataScope; requestId: string; phase: "approve" | "execute" },
  at: Date,
): Promise<CancelRecheckEntry> {
  const request = await tx.cancelRequest.findFirst({
    where: { id: input.requestId, store: managedStore(input.scope) },
    include: { cancelRequestLines: { orderBy: { id: "asc" } } },
  });
  if (!request) throw new AppError("NOT_FOUND");
  const diffs: CancelRecheckEntry["diffs"] = [];
  const compare = (lineId: string, field: string, expected: unknown, actual: unknown) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      diffs.push({ lineId, field, expected, actual });
  };
  const reasonCode = CancelReasonSchema.parse(request.reasonCode);
  const expectedStatus = input.phase === "approve" ? "pending_approval" : "pending_execution";
  // Header diffs use the first immutable line as the concrete affected line. Empty headers are invalid.
  const first = request.cancelRequestLines[0];
  if (!first) throw new AppError("PRECONDITION_CHANGED", { message: "取消申请没有明细" });
  compare(first.id, "request.status", expectedStatus, request.status);
  compare(first.id, "request.closedAt", null, request.closedAt);
  compare(first.id, "request.lineCount", request.lineCount, request.cancelRequestLines.length);
  compare(
    first.id,
    "request.qualificationReason",
    request.kind === "qualification_cancel",
    reasonCode === "qualification_final",
  );
  compare(
    first.id,
    "request.kind",
    true,
    ["order_cancel", "ad_cancel", "qualification_cancel"].includes(request.kind),
  );
  for (const [field, actual] of [
    [
      "totalBasePoints",
      request.cancelRequestLines.reduce((n, l) => n + l.chargePoints - l.priorRequestedPoints, 0),
    ],
    ["totalDeductPoints", request.cancelRequestLines.reduce((n, l) => n + l.deductPoints, 0)],
    ["totalRefundPoints", request.cancelRequestLines.reduce((n, l) => n + l.refundPoints, 0)],
  ] as const)
    compare(first.id, `request.${field}`, request[field], actual);
  const pauseTargets = await readCancelReviewPauseTargets(tx, [request.approvalRequestId]);
  for (const line of request.cancelRequestLines) {
    compare(line.id, "entityId", request.entityId, line.entityId);
    compare(line.id, "storeId", request.storeId, line.storeId);
    compare(line.id, "executedAt", null, line.executedAt);
    let current: CancelQuoteLine | { blocker: string } | null = null;
    try {
      const options = {
        terminationDate: date(line.terminationDate) ?? undefined,
        manualDeduct:
          line.ratioBp === null && line.stage === "post_sample"
            ? { deductPoints: line.deductPoints, deductNote: line.deductNote ?? "" }
            : undefined,
        submittedAt: request.createdAt,
      };
      if (line.targetType === "order_item") {
        const item = await tx.orderItem.findUnique({
          where: { id: line.targetId },
          include: { dramaOrder: true },
        });
        compare(line.id, "targetExists", true, item !== null);
        if (!item) continue;
        compare(line.id, "entityId", request.entityId, item.entityId);
        compare(line.id, "storeId", request.storeId, item.storeId);
        compare(line.id, "pointHoldId", line.pointHoldId, item.pointHoldId);
        compare(line.id, "openCancelRequestId", request.id, item.dramaOrder.openCancelRequestId);
        compare(
          line.id,
          "targetKind",
          true,
          request.kind !== "ad_cancel" &&
            (request.kind !== "order_cancel" || request.dramaOrderId === item.dramaOrderId),
        );
        const facts = await orderCancelFacts(tx, item);
        if (!["pending_start", "live"].includes(line.stage))
          compare(
            line.id,
            "cancelReviewPause",
            true,
            facts.ticket !== null &&
              pauseTargets.deliveryTicketIds.includes(facts.ticket.deliveryTicketId),
          );
        if (line.stage === "live")
          compare(
            line.id,
            "liveStep",
            true,
            facts.ticket !== null && ["in_service", "takedown"].includes(facts.ticket.step),
          );
        current = await calculateCancelFacts(tx, facts, reasonCode, at, options);
      } else if (line.targetType === "ad") {
        const ad = await readAdCancelFacts(tx, line.targetId);
        compare(line.id, "targetExists", true, ad !== null);
        if (!ad) continue;
        compare(line.id, "entityId", request.entityId, ad.entityId);
        compare(line.id, "storeId", request.storeId, ad.storeId);
        compare(line.id, "pointHoldId", line.pointHoldId, ad.pointHoldId);
        compare(line.id, "openCancelRequestId", request.id, ad.openCancelRequestId);
        compare(
          line.id,
          "targetKind",
          true,
          request.kind !== "order_cancel" &&
            (request.kind !== "ad_cancel" || request.adId === ad.id),
        );
        const bound = await boundCancelAdItems(tx, ad.id);
        compare(line.id, "boundOrderItemIds", [], bound);
        current = await calculateCancelFacts(tx, adCancelFacts(ad), reasonCode, at, options);
      } else compare(line.id, "targetType", "order_item|ad", line.targetType);
      if (!current) continue;
      if ("blocker" in current) {
        compare(line.id, "eligibility", "eligible", current.blocker);
        continue;
      }
      const expected = {
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
      };
      for (const field of Object.keys(expected) as (keyof typeof expected)[]) {
        // Live may legitimately move in_service→takedown; fixed dates and destinations are the guard.
        if (line.stage === "live" && field === "stepAtSubmit") continue;
        compare(line.id, field, expected[field], current[field]);
      }
      const preview = ReturnBreakdownSchema.parse(line.previewSnapshot);
      for (const field of ["qty", "backToOriginal", "convertedToAddon", "forfeited"] as const)
        compare(line.id, `preview.${field}`, preview[field], current.preview[field]);
    } catch (error) {
      // Only facts failures become evidence. Account contention and internal ledger failures
      // retain their original retry/error semantics and never masquerade as a changed quote.
      const factsFailure =
        (error instanceof AppError &&
          ["PRECONDITION_CHANGED", "STATE_NOT_ALLOWED", "NOT_FOUND"].includes(error.error)) ||
        (error instanceof Error && ["HoldStateError", "ZodError"].includes(error.name));
      if (!factsFailure || !(error instanceof Error)) throw error;
      diffs.push({ lineId: line.id, field: "facts", expected: "valid", actual: error.message });
    }
  }
  return CancelRecheckEntrySchema.parse({ at: at.toISOString(), ok: diffs.length === 0, diffs });
}
