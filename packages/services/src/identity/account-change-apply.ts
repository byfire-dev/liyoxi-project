import type { ApprovalDecision, ApprovalRow } from "../approval/index.js";
import type { Prisma } from "@liyoxi/db";
import { assertConfirm } from "../authz/index.js";
import type { Guard } from "../flow/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { blindIndex } from "../security/index.js";
import { transferOwnerIn } from "../tenant/index.js";
import { accountChangeCall } from "./account-change-context.js";
import { accountChangeInclude, checkIssue, inputFor, precheck } from "./account-change-facts.js";
import { changePhoneIn } from "./phone-change.js";

const registrations = new WeakMap<
  Tx,
  { ctx: IdentityContext; requestId: string; userId: string }
>();
/** 仅真实通过老板更换新建账号免首次同意；普通register仍走原consent守卫。 */
export const guardApprovedAccountRegistration: Guard = async (tx, facts) => {
  const state = registrations.get(tx);
  if (
    !state ||
    facts.ctx !== state.ctx ||
    facts.subjectId !== state.userId ||
    facts.event !== "merchant_user.register"
  )
    return false;
  const { deps } = accountChangeCall(tx);
  const request = await tx.accountChangeRequest.findUnique({
    where: { id: state.requestId },
    include: { approvalRequest: true },
  });
  const user = await tx.merchantUser.findUnique({ where: { id: state.userId } });
  if (
    !request ||
    request.kind !== "owner_transfer" ||
    request.appliedAt ||
    !request.newPhoneEnc ||
    request.approvalRequest.status !== "approved" ||
    state.ctx.actor.type !== "staff" ||
    request.approvalRequest.decidedByStaffId !== state.ctx.actor.id ||
    !user?.phoneBidx ||
    user.consentStamp !== null ||
    user.sourceType !== "organic"
  )
    return false;
  const input = inputFor({ ...request, merchantUser: null, entity: null }, deps);
  return Boolean(
    input.newPhone &&
    Buffer.from(user.phoneBidx).equals(blindIndex(deps.keyring(), "phone", input.newPhone)),
  );
};
export async function revalidateAccountChange(tx: Tx, row: ApprovalRow) {
  const state = accountChangeCall(tx),
    request = await tx.accountChangeRequest.findUnique({
      where: { approvalRequestId: row.id },
      include: accountChangeInclude,
    });
  if (!request || request.id !== state.requestId) throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "account_change_request", [request.id]);
  assertConfirm(state.confirm, { requestNo: row.requestNo, newPhoneMask: request.newPhoneMask });
  const result = await precheck(tx, state.deps, inputFor(request, state.deps));
  checkIssue(result, true);
  if (result.entityId !== request.entityId)
    throw new AppError("PRECONDITION_CHANGED", { details: { reason: "target_not_active" } });
  if (request.kind === "phone_rebind" && result.occupant?.id === request.merchantUserId)
    throw new AppError("PRECONDITION_CHANGED", { details: { reason: "phone_taken" } });
}
export async function applyAccountChange(tx: Tx, row: ApprovalRow, decision: ApprovalDecision) {
  const state = accountChangeCall(tx),
    { deps, ctx } = state;
  const request = await tx.accountChangeRequest.findUniqueOrThrow({
    where: { approvalRequestId: row.id },
    include: accountChangeInclude,
  });
  if (
    request.id !== state.requestId ||
    row.status !== "approved" ||
    ctx.actor.type !== "staff" ||
    decision.decidedByStaffId !== ctx.actor.id
  )
    throw new AppError("PRECONDITION_CHANGED");
  const input = inputFor(request, deps),
    result = await precheck(tx, deps, input);
  checkIssue(result, true);
  let snapshot: Prisma.InputJsonObject;
  if (request.kind === "phone_rebind") {
    const changed = await changePhoneIn(
      tx,
      deps,
      {
        merchantUserId: request.merchantUserId!,
        phone: input.newPhone!,
        keepSessionId: null,
        via: "approval",
        accountChangeRequestId: request.id,
        approvalRequestId: row.id,
        approvalContext: ctx,
      },
      { requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent, clientVersion: null },
      state.occupantId ?? null,
      state.occupantChanges ?? [],
    );
    state.oldPhone = changed.oldPhone;
    snapshot = {
      purgedUserId: state.occupantId ?? null,
      prevPhoneMask: request.merchantUser!.phoneMask!,
    };
  } else if (request.kind === "owner_transfer") {
    const userId = state.newOwnerUserId;
    if (!userId) throw new AppError("INTERNAL");
    if (state.newOwnerAccountCreated) {
      registrations.set(tx, { ctx, requestId: request.id, userId });
      try {
        await deps.flow.transition(tx, ctx, {
          machine: "merchant_user",
          stateField: "status",
          id: userId,
          event: "merchant_user.register",
          ref: "02:125",
          created: true,
          audit: { mergedInto: { approvalRequestId: row.id } },
          emit: {
            type: "merchant_user.registered",
            payload: {
              v: 1,
              merchantUserId: userId,
              via: "owner_transfer",
              sourceType: "organic",
              sourceReferralCodeId: null,
            },
          },
        });
      } finally {
        registrations.delete(tx);
      }
    }
    const transferred = await transferOwnerIn(tx, deps, ctx, {
      accountChangeRequestId: request.id,
      newOwnerUserId: userId,
    });
    snapshot = {
      newOwnerUserId: userId,
      newOwnerAccountCreated: state.newOwnerAccountCreated ?? false,
      ...transferred,
    };
  } else {
    const bypassUntil = new Date(decision.decidedAt.getTime() + 72 * 3600000);
    await tx.merchantUser.update({
      where: { id: request.merchantUserId! },
      data: { dormantBypassUntil: bypassUntil, updatedAt: decision.decidedAt },
    });
    snapshot = { bypassUntil: bypassUntil.toISOString() };
  }
  await tx.accountChangeRequest.update({
    where: { id: request.id },
    data: {
      appliedAt: decision.decidedAt,
      resultSnapshot: snapshot,
      newPhoneEnc: null,
      updatedAt: decision.decidedAt,
    },
  });
}
export async function clearAccountChangeRequest(tx: Tx, row: ApprovalRow) {
  const request = await tx.accountChangeRequest.findUnique({
    where: { approvalRequestId: row.id },
  });
  if (!request) throw new AppError("NOT_FOUND");
  await lockRows(tx, "account_change_request", [request.id]);
  await tx.accountChangeRequest.update({
    where: { id: request.id },
    data: { newPhoneEnc: null, updatedAt: row.decidedAt! },
  });
}
