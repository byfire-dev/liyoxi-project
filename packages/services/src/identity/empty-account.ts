import type { Approval } from "../approval/index.js";
import type { Flow } from "../flow/index.js";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Clock, Tx } from "../kernel/index.js";

export async function pendingAccountChanges(tx: Tx, userId: string) {
  return tx.accountChangeRequest.findMany({
    where: { merchantUserId: userId, approvalRequest: { status: "pending" } },
    select: { id: true, approvalRequestId: true },
    orderBy: { id: "asc" },
  });
}
/** 调用者在账号80之前取得审批30/申请40全集；锁后重读，新增低序行则整笔重试。 */
export async function lockAccountChanges(tx: Tx, userId: string) {
  const rows = await pendingAccountChanges(tx, userId);
  await lockRows(tx, "approval_request", rows.map((r) => r.approvalRequestId).sort());
  await lockRows(
    tx,
    "account_change_request",
    rows.map((r) => r.id),
  );
  return rows;
}
export async function purgeEmptyAccountIn(
  tx: Tx,
  deps: { clock: Clock; flow: Flow; approval: Pick<Approval, "withdraw"> },
  userId: string,
  planned: Awaited<ReturnType<typeof pendingAccountChanges>>,
  mergedIntoApprovalId?: string,
) {
  const account = await tx.merchantUser.findUnique({ where: { id: userId } });
  if (
    !account ||
    account.status !== "active" ||
    (await tx.entityMember.count({ where: { merchantUserId: userId } }))
  )
    throw new AppError("PHONE_TAKEN");
  await withdrawAccountChangesIn(tx, deps.approval, userId, planned);
  await clearPersonalAccountIn(tx, deps.clock.now(), userId);
  const ctx = createIdentityContext({ actor: { type: "system", job: "identity.purge_empty" } });
  await deps.flow.transition(tx, ctx, {
    machine: "merchant_user",
    stateField: "status",
    id: userId,
    event: "merchant_user.purge_empty",
    ref: "02:129",
    set: deletedPersonalFields(deps.clock.now()),
    audit: mergedIntoApprovalId
      ? { mergedInto: { approvalRequestId: mergedIntoApprovalId } }
      : {
          stream: "ops",
          category: "account_security",
          action: "identity.merchant_user.purge_empty",
          summary: "清理空账号",
          target: { type: "merchant_user", id: userId, label: account.phoneMask },
        },
    emit: {
      type: "merchant_user.deleted",
      payload: { v: 1, merchantUserId: userId, reason: "purge_empty" },
    },
  });
}

export async function withdrawAccountChangesIn(
  tx: Tx,
  approval: Pick<Approval, "withdraw">,
  userId: string,
  planned: Awaited<ReturnType<typeof pendingAccountChanges>>,
) {
  const current = await pendingAccountChanges(tx, userId);
  if (current.some((row) => !planned.some((old) => old.id === row.id))) throw new AppError("BUSY");
  const ctx = createIdentityContext({ actor: { type: "system", job: "identity.purge_empty" } });
  for (const row of current)
    await approval.withdraw(tx, ctx, { approvalId: row.approvalRequestId });
}

/** 只清个人依附，不碰交易、审计、同意、成员历史；调用者在原事务持账号锁。 */
export async function clearPersonalAccountIn(tx: Tx, now: Date, userId: string) {
  await tx.userSession.updateMany({
    where: { merchantUserId: userId, revokedAt: null },
    data: { revokedAt: now, revokeReason: "account_deleted", updatedAt: now },
  });
  await tx.portalSession.updateMany({
    where: { approvedByUserId: userId, revokedAt: null },
    data: { revokedAt: now, revokeReason: "account_action", updatedAt: now },
  });
  await tx.portalSession.deleteMany({ where: { approvedByUserId: userId } });
  await tx.userSession.deleteMany({ where: { merchantUserId: userId } });
  await tx.wechatIdentity.deleteMany({ where: { merchantUserId: userId } });
  await tx.smsVerification.deleteMany({ where: { merchantUserId: userId } });
  await tx.merchantUserNotice.deleteMany({ where: { merchantUserId: userId } });
  await tx.wecomContact.deleteMany({ where: { merchantUserId: userId } });
}
export const deletedPersonalFields = (now: Date) => ({
  phone_enc: null,
  phone_bidx: null,
  phone_mask: null,
  phone_last4: null,
  display_name: null,
  deleted_at: now,
});
