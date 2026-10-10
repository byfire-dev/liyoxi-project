import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import type { ReturnResult } from "../billing/index.js";
import type { Events } from "../events/index.js";
import { chainKey, rowKey } from "../flow/index.js";
import type { Flow, MachineBinding } from "../flow/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import type { Timers } from "../timers/index.js";

interface CancelAdInput {
  adId: string;
  entityId: string;
  storeId: string;
  cancelRequestId: string;
  approvalRequestId: string;
  reasonCode: string;
  refundPoints: number;
  now: Date;
}
const passes = new WeakSet<object>();
const guard: NonNullable<MachineBinding["guards"]>[string] = (_tx, facts) =>
  Promise.resolve(typeof facts.args === "object" && facts.args !== null && passes.has(facts.args));
export const adCancelChain = chainKey("ad", "status");
export const adCancelBinding: MachineBinding = {
  companions: ["cancelled_at", "cancel_reason_code", "open_cancel_request_id"],
  guards: { [rowKey("09:808", "ad.cancel")]: guard, [rowKey("09:809", "ad.cancel")]: guard },
};
export async function claimAdCancelRequest(
  tx: Tx,
  input: Omit<CancelAdInput, "approvalRequestId" | "reasonCode" | "refundPoints">,
) {
  await lockRows(tx, "ad", [input.adId]);
  const changed = await tx.ad.updateMany({
    where: {
      id: input.adId,
      entityId: input.entityId,
      storeId: input.storeId,
      openCancelRequestId: null,
      status: { notIn: ["confirmed", "cancelled"] },
    },
    data: {
      openCancelRequestId: input.cancelRequestId,
      lockVersion: { increment: 1 },
      updatedAt: input.now,
    },
  });
  if (changed.count !== 1) throw new AppError("AD_CANCEL_IN_PROGRESS");
}
/** Caller owns the stable request/line/ad/binding graph and the sole account lock.
 * State goes first; the real ledger callback and all four quantities remain in this transaction.
 */
export async function cancelAd(
  tx: Tx,
  deps: { flow: Flow; events: Events; timers: Timers },
  ctx: IdentityContext,
  input: CancelAdInput,
  returnPoints: () => Promise<
    Pick<ReturnResult, "returnedPoints" | "convertedPoints" | "forfeitedPoints">
  >,
) {
  await lockRows(tx, "ad", [input.adId]);
  const ad = await tx.ad.findUnique({ where: { id: input.adId } });
  if (
    !ad ||
    ad.entityId !== input.entityId ||
    ad.storeId !== input.storeId ||
    ad.openCancelRequestId !== input.cancelRequestId
  )
    throw new AppError("PRECONDITION_CHANGED");
  const unassigned =
    ad.status === "pending_assign" ||
    (ad.status === "returned" && ad.returnedFrom === "pending_assign");
  const producing =
    ["producing", "revising", "pending_confirm"].includes(ad.status) ||
    (ad.status === "returned" && ad.returnedFrom === "producing");
  if (!unassigned && !producing) throw new AppError("AD_NOT_CANCELLABLE");
  const pass = Object.freeze({});
  passes.add(pass);
  const transitioned = await deps.flow.transition(tx, ctx, {
    machine: "ad",
    stateField: "status",
    id: ad.id,
    event: "ad.cancel",
    ref: unassigned ? "09:808" : "09:809",
    set: {
      cancelled_at: input.now,
      cancel_reason_code: input.reasonCode,
      open_cancel_request_id: null,
    },
    entityId: ad.entityId,
    storeId: ad.storeId,
    reasonCode: input.reasonCode,
    audit: { mergedInto: { approvalRequestId: input.approvalRequestId } },
    emit: { none: true, primary: "cancel.executed" },
    args: pass,
  });
  const result = await returnPoints();
  if (
    result.returnedPoints + result.convertedPoints + result.forfeitedPoints !==
    input.refundPoints
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "账本实际退回数量不一致" });
  await tx.ad.update({
    where: { id: ad.id },
    data: {
      refundRequestedPoints: ad.refundRequestedPoints + input.refundPoints,
      returnedPoints: ad.returnedPoints + result.returnedPoints,
      convertedPoints: ad.convertedPoints + result.convertedPoints,
      forfeitedPoints: ad.forfeitedPoints + result.forfeitedPoints,
    },
  });
  const subject = { type: "ad", id: ad.id };
  for (const purpose of ["first", "rev"])
    await deps.timers.cancel(tx, {
      subject,
      kinds: ["sla.breach"],
      keyPrefix: `${timerKey("sla.breach", subject, purpose)}:`,
    });
  await deps.timers.cancel(tx, {
    subject,
    kinds: ["ad.returned_stale"],
    keyPrefix: `${timerKey("ad.returned_stale", subject)}:`,
  });
  await deps.events.emit(tx, ctx, {
    type: "ad.cancelled",
    aggregate: subject,
    entityId: ad.entityId,
    storeId: ad.storeId,
    dedupeKey: `ad.cancelled:${input.cancelRequestId}:${ad.id}`,
    payload: EVENT_PAYLOAD_SCHEMAS["ad.cancelled"].parse({
      v: 1,
      adId: ad.id,
      cancelRequestId: input.cancelRequestId,
      returnedPoints: result.returnedPoints + result.convertedPoints,
      forfeitedPoints: result.forfeitedPoints,
      fromState: transitioned.from,
      toState: transitioned.to,
      transition: "ad.cancel",
    }),
  });
  return result;
}
