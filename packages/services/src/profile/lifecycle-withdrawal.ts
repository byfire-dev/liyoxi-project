import type { ApprovalDecision, ApprovalRow } from "../approval/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { ProfileLifecycleDeps } from "./context.js";
import { refreshCompleteness } from "./repo.js";

// 仅在真实订阅事务调用审批 withdraw 时绑定；商家决定入口不能获得此能力。
const calls = new WeakMap<
  Tx,
  {
    deps: ProfileLifecycleDeps;
    ctx: IdentityContext;
    entityId: string;
  }
>();
export async function withLifecycleWithdrawal<T>(
  tx: Tx,
  deps: ProfileLifecycleDeps,
  ctx: IdentityContext,
  entityId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (ctx.actor.type !== "system" || calls.has(tx))
    throw new TypeError("生命周期撤回只能以独立系统上下文绑定一次");
  calls.set(tx, { deps, ctx, entityId });
  try {
    return await fn();
  } finally {
    calls.delete(tx);
  }
}

export async function onLifecycleWithdrawn(
  tx: Tx,
  row: ApprovalRow,
  decision: ApprovalDecision,
): Promise<void> {
  const bound = calls.get(tx);
  if (!bound || bound.ctx.actor.type !== "system" || !decision.isDecidedBySystem)
    throw new AppError("STATE_NOT_ALLOWED", { details: { reason: "merchant_withdraw_not_open" } });
  const { deps, ctx, entityId } = bound;
  const first = await tx.qualificationSubmission.findUnique({
    where: { approvalRequestId: row.id },
  });
  if (!first) throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "qualification_submission", [first.id]);
  await lockRows(tx, "entity", [entityId]);
  await lockRows(tx, "store", [first.storeId]);
  await lockRows(tx, "store_profile", [first.storeId]);
  const round = await tx.qualificationSubmission.findUniqueOrThrow({ where: { id: first.id } });
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId } });
  const store = await tx.store.findUniqueOrThrow({ where: { id: round.storeId } });
  const approval = await tx.approvalRequest.findUniqueOrThrow({ where: { id: row.id } });
  if (
    !["closed", "abandoned"].includes(entity.lifecycle) ||
    round.entityId !== entityId ||
    store.entityId !== entityId ||
    round.closedAt !== null ||
    round.submittedAt === null ||
    row.kind !== "qualification" ||
    row.status !== "withdrawn" ||
    approval.status !== "withdrawn" ||
    !approval.isDecidedBySystem ||
    row.entityId !== entityId ||
    row.storeId !== round.storeId ||
    row.subjectType !== "store" ||
    row.subjectId !== round.storeId ||
    row.roundNo !== round.roundNo ||
    round.approvalRequestId !== row.id ||
    !["initial", "new_store", "change"].includes(round.kind)
  )
    throw new AppError("PRECONDITION_CHANGED");
  const kind = round.kind as "initial" | "new_store" | "change";
  await deps.tenant.setStoreQualification(tx, ctx, {
    storeId: round.storeId,
    round: kind,
    action: "withdraw",
    audit: { mergedInto: { approvalRequestId: row.id } },
  });
  await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: { closedAt: decision.decidedAt, outcome: "withdrawn", updatedAt: decision.decidedAt },
  });
  if (await tx.storeProfile.findUnique({ where: { storeId: round.storeId } }))
    await refreshCompleteness(tx, round.storeId, decision.decidedAt);
  await deps.events.emit(tx, ctx, {
    type:
      kind === "change" ? "store.qualification_change.withdrawn" : "store.qualification.withdrawn",
    aggregate: { type: "store", id: round.storeId },
    entityId,
    storeId: round.storeId,
    payload: { v: 1, storeId: round.storeId, submissionId: round.id },
    dedupeKey: `qualification-withdrawn:${round.id}`,
  });
}
