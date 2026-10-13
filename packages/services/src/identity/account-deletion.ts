import type { Approval } from "../approval/index.js";
import type { Flow, Guard } from "../flow/index.js";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx, TxRunner } from "../kernel/index.js";
import { clearAccountMemberNamesIn } from "../tenant/index.js";
import type { Tenant } from "../tenant/index.js";
import { assertCurrentSession } from "./current-session.js";
import {
  clearPersonalAccountIn,
  deletedPersonalFields,
  lockAccountChanges,
  withdrawAccountChangesIn,
} from "./empty-account.js";
import type { IdempotencyContext } from "../kernel/index.js";
import type { RequestMeta, SessionPrincipal } from "./types.js";

interface Deps {
  tx: TxRunner;
  clock: Clock;
  flow: Pick<Flow, "transition">;
  tenant: Pick<Tenant, "activeMembership" | "closeEntityForOwnerDeletionIn" | "removeMemberIn">;
  appid: string;
  approval?: Pick<Approval, "withdraw">;
}
type Prepared = { userId: string; ctx: IdentityContext; closedEntityId: string | null };
const prepared = new WeakMap<Tx, Prepared>();

/** 只能由同Tx真实账号清理发起，不能用args布尔值伪造注销授权。 */
export const guardSelfDeletion: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (
    !state ||
    facts.ctx !== state.ctx ||
    facts.subjectId !== state.userId ||
    facts.event !== "merchant_user.delete"
  )
    return false;
  if (
    state.closedEntityId &&
    (
      await tx.entity.findUnique({
        where: { id: state.closedEntityId },
        select: { lifecycle: true },
      })
    )?.lifecycle !== "closed"
  )
    return false;
  const counts = await Promise.all([
    tx.entityMember.count({
      where: {
        merchantUserId: state.userId,
        OR: [{ status: "active" }, { displayName: { not: null } }],
      },
    }),
    tx.userSession.count({ where: { merchantUserId: state.userId } }),
    tx.portalSession.count({ where: { approvedByUserId: state.userId } }),
    tx.wechatIdentity.count({ where: { merchantUserId: state.userId } }),
    tx.smsVerification.count({ where: { merchantUserId: state.userId } }),
    tx.merchantUserNotice.count({ where: { merchantUserId: state.userId } }),
    tx.wecomContact.count({ where: { merchantUserId: state.userId } }),
    tx.accountChangeRequest.count({
      where: { merchantUserId: state.userId, approvalRequest: { status: "pending" } },
    }),
  ]);
  return counts.every((count) => count === 0);
};

export async function deleteAccount(
  deps: Deps,
  principal: SessionPrincipal,
  meta: RequestMeta,
  input: { hasConfirmed: true },
  options: { idem?: IdempotencyContext } = {},
): Promise<{ deletedAt: string }> {
  if (input.hasConfirmed !== true) throw new AppError("VALIDATION_FAILED");
  // 成功后会话已删；同键重放也必须先按当前身份拒绝。
  await deps.tx.run((tx) => assertCurrentSession(tx, principal, deps.clock.now(), deps.appid));
  return deps.tx.run(async (tx) => {
    if (!deps.approval) throw new AppError("INTERNAL");
    const changes = await lockAccountChanges(tx, principal.merchantUserId);
    await lockRows(tx, "merchant_user", [principal.merchantUserId]);
    await assertCurrentSession(tx, principal, deps.clock.now(), deps.appid);
    const account = await tx.merchantUser.findUniqueOrThrow({
      where: { id: principal.merchantUserId },
    });
    const identities = await tx.wechatIdentity.findMany({
      where: { merchantUserId: account.id },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    await lockRows(
      tx,
      "wechat_identity",
      identities.map((row) => row.id),
    );
    // 审批30/申请40已全预锁；系统代撤在tenant高序锁之前完成。
    await withdrawAccountChangesIn(tx, deps.approval, account.id, changes);
    const membership = await deps.tenant.activeMembership(tx, account.id);
    const ctx = createIdentityContext({
      actor: { type: "merchant", id: account.id, client: "weapp", role: membership?.role ?? null },
      ...meta,
    });
    let closedEntityId: string | null = null;
    if (membership?.role === "owner") {
      const closed = await deps.tenant.closeEntityForOwnerDeletionIn(tx, ctx);
      closedEntityId = closed.entityId;
    } else if (membership) {
      await deps.tenant.removeMemberIn(tx, ctx, { kind: "account_deleted" });
    }
    await clearAccountMemberNamesIn(tx, ctx, deps.clock.now());
    await assertCurrentSession(tx, principal, deps.clock.now(), deps.appid);
    const now = deps.clock.now();
    await clearPersonalAccountIn(tx, now, account.id);
    if (prepared.has(tx)) throw new AppError("INTERNAL");
    prepared.set(tx, { userId: account.id, ctx, closedEntityId });
    try {
      await deps.flow.transition(tx, ctx, {
        machine: "merchant_user",
        stateField: "status",
        id: account.id,
        event: "merchant_user.delete",
        ref: "02:128",
        set: deletedPersonalFields(now),
        audit: {
          stream: "ops",
          category: "account_security",
          action: "identity.merchant_user.delete",
          summary: "注销账号",
          target: { type: "merchant_user", id: account.id, label: account.phoneMask },
        },
        emit: {
          type: "merchant_user.deleted",
          payload: { v: 1, merchantUserId: account.id, reason: "self_deleted" },
        },
      });
    } finally {
      prepared.delete(tx);
    }
    return { deletedAt: now.toISOString() };
  }, options);
}
