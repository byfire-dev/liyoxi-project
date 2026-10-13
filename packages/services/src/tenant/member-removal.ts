// W2-10：老板移除店员与本人退出，共用原事务、锁序与成员状态机。
import type { MemberRemovalResult } from "@liyoxi/contract";
import type { Flow, Guard } from "../flow/index.js";
import { AppError, createIdentityContext, isUuid, lockRows } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";
import { resolveMembership } from "./membership.js";

interface Removal {
  readonly ctx: IdentityContext;
  readonly entityId: string;
  readonly operatorId: string;
  readonly targetId: string;
  readonly event: "entity_member.remove" | "entity_member.leave";
}

// 防止绕过领域用例直接迁移成员，漏掉门店关系清理。
const prepared = new WeakMap<Tx, Removal>();

async function check(tx: Tx, input: Removal) {
  const { ctx, entityId, operatorId, targetId, event } = input;
  const [entity, operator, target] = await Promise.all([
    tx.entity.findUnique({ where: { id: entityId } }),
    tx.entityMember.findUnique({ where: { id: operatorId } }),
    tx.entityMember.findUnique({ where: { id: targetId } }),
  ]);
  const membership =
    ctx.actor.type === "merchant" && ctx.storeId
      ? await resolveMembership(tx, { merchantUserId: ctx.actor.id, storeId: ctx.storeId })
      : null;
  if (
    ctx.actor.type !== "merchant" ||
    ctx.actor.client !== "weapp" ||
    !ctx.storeId ||
    entity?.lifecycle !== "active" ||
    !operator ||
    operator.entityId !== entityId ||
    operator.merchantUserId !== ctx.actor.id ||
    operator.status !== "active" ||
    membership?.entityId !== entityId ||
    membership.memberId !== operatorId
  )
    throw new AppError("NOT_A_MEMBER");
  if (event === "entity_member.remove" && operator.role !== "owner")
    throw new AppError("ROLE_FORBIDDEN");
  if (event === "entity_member.remove" && membership.storeMode !== "active")
    throw new AppError("STORE_ARCHIVED");
  if (event === "entity_member.leave" && operator.role === "owner")
    throw new AppError("OWNER_CANNOT_LEAVE");
  if (!target || target.entityId !== entityId) throw new AppError("NOT_FOUND");
  if (target.role !== "clerk" || target.status !== "active")
    throw new AppError("STATE_NOT_ALLOWED");
  if (event === "entity_member.leave" && target.id !== operator.id)
    throw new AppError("NOT_A_MEMBER");
  return target;
}

/** 仅在本事务真实用例已取得主体与成员全集锁时放行原矩阵的 remove/leave 两行。 */
export const guardMemberRemoval: Guard = async (tx, facts) => {
  const bound = prepared.get(tx);
  if (
    !bound ||
    facts.subjectId !== bound.targetId ||
    facts.entityId !== bound.entityId ||
    facts.ctx !== bound.ctx ||
    facts.event !== bound.event
  )
    return false;
  await check(tx, bound);
  return true;
};

export async function removeMemberIn(
  tx: Tx,
  flow: Flow,
  now: Date,
  ctx: IdentityContext,
  memberId?: string,
): Promise<MemberRemovalResult> {
  if (ctx.actor.type !== "merchant") throw new AppError("ROLE_FORBIDDEN");
  const entityId = ctx.entityId;
  if (!entityId || !ctx.storeId || ctx.actor.client !== "weapp") throw new AppError("NOT_A_MEMBER");
  await lockRows(tx, "entity", [entityId]);
  const operator = await tx.entityMember.findFirst({
    where: { entityId, merchantUserId: ctx.actor.id, status: "active" },
  });
  if (!operator) throw new AppError("NOT_A_MEMBER");
  if (memberId !== undefined && operator.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  const targetId = memberId ?? operator.id;
  const candidate = await tx.entityMember.findUnique({
    where: { id: targetId },
    select: { entityId: true },
  });
  if (!candidate || candidate.entityId !== entityId) throw new AppError("NOT_FOUND");
  await lockRows(tx, "entity_member", [...new Set([operator.id, targetId])].sort());
  const input: Removal = {
    ctx,
    entityId,
    operatorId: operator.id,
    targetId,
    event: memberId === undefined ? "entity_member.leave" : "entity_member.remove",
  };
  const target = await check(tx, input);
  const reason = memberId === undefined ? "self" : "by_owner";
  if (prepared.has(tx)) throw new TypeError("成员移除用例不能重入");
  prepared.set(tx, input);
  try {
    return await writeRemoval(
      tx,
      flow,
      now,
      ctx,
      target.id,
      target.merchantUserId,
      entityId,
      input.event,
      reason,
      false,
    );
  } finally {
    prepared.delete(tx);
  }
}

export type CallerMemberRemoval =
  | { readonly kind: "owner_remove"; readonly memberId: string }
  | { readonly kind: "leave" }
  | { readonly kind: "dormant" }
  | { readonly kind: "account_deleted" };
type AccountRemoval = { ctx: IdentityContext; entityId: string; memberId: string; userId: string };
const accountPrepared = new WeakMap<Tx, AccountRemoval>();
async function currentAccountMember(tx: Tx, input: AccountRemoval) {
  const [user, entity, member] = await Promise.all([
    tx.merchantUser.findUnique({ where: { id: input.userId } }),
    tx.entity.findUnique({ where: { id: input.entityId } }),
    tx.entityMember.findUnique({ where: { id: input.memberId } }),
  ]);
  if (
    user?.status !== "active" ||
    entity?.lifecycle !== "active" ||
    member?.merchantUserId !== input.userId ||
    member.entityId !== input.entityId ||
    member.status !== "active"
  )
    throw new AppError("PRECONDITION_CHANGED");
  if (member.role !== "clerk") throw new AppError("ROLE_FORBIDDEN");
}
export const guardAccountMemberRemoval: Guard = async (tx, facts) => {
  const input = accountPrepared.get(tx);
  if (
    !input ||
    facts.ctx !== input.ctx ||
    facts.entityId !== input.entityId ||
    facts.subjectId !== input.memberId ||
    facts.event !== "entity_member.cascade_remove"
  )
    return false;
  await currentAccountMember(tx, input);
  return true;
};
/** 调用方拥有账号级认证/休眠判定；目标始终从本人当前关系派生。 */
export async function removeCallerMemberIn(
  tx: Tx,
  deps: { flow: Flow; clock: Clock },
  ctx: IdentityContext,
  input: CallerMemberRemoval,
): Promise<MemberRemovalResult> {
  if (ctx.actor.type !== "merchant" || ctx.actor.client !== "weapp")
    throw new AppError("ROLE_FORBIDDEN");
  if (!input || !["owner_remove", "leave", "dormant", "account_deleted"].includes(input.kind))
    throw new AppError("VALIDATION_FAILED");
  await lockRows(tx, "merchant_user", [ctx.actor.id]);
  const user = await tx.merchantUser.findUnique({ where: { id: ctx.actor.id } });
  if (user?.status !== "active") throw new AppError("NOT_A_MEMBER");
  if (input.kind === "owner_remove") {
    if (!isUuid(input.memberId)) throw new AppError("VALIDATION_FAILED");
    return removeMemberIn(tx, deps.flow, deps.clock.now(), ctx, input.memberId);
  }
  if (input.kind === "leave") return removeMemberIn(tx, deps.flow, deps.clock.now(), ctx);
  if (accountPrepared.has(tx)) throw new AppError("INTERNAL");
  const member = await tx.entityMember.findFirst({
    where: { merchantUserId: ctx.actor.id, status: "active" },
  });
  if (!member) throw new AppError("NOT_A_MEMBER");
  if (member.role !== "clerk") throw new AppError("ROLE_FORBIDDEN");
  await lockRows(tx, "entity", [member.entityId]);
  await lockRows(tx, "entity_member", [member.id]);
  const actor =
    input.kind === "dormant"
      ? { type: "system" as const, job: "tenant.dormant_member" }
      : ctx.actor;
  const effective = createIdentityContext({
    ...ctx,
    actor,
    entityId: member.entityId,
    storeId: null,
  });
  const state = {
    ctx: effective,
    entityId: member.entityId,
    memberId: member.id,
    userId: ctx.actor.id,
  };
  await currentAccountMember(tx, state);
  accountPrepared.set(tx, state);
  try {
    return await writeRemoval(
      tx,
      deps.flow,
      deps.clock.now(),
      effective,
      member.id,
      ctx.actor.id,
      member.entityId,
      "entity_member.cascade_remove",
      input.kind,
      true,
    );
  } finally {
    accountPrepared.delete(tx);
  }
}
async function writeRemoval(
  tx: Tx,
  flow: Flow,
  now: Date,
  ctx: IdentityContext,
  targetId: string,
  userId: string,
  entityId: string,
  event: "entity_member.remove" | "entity_member.leave" | "entity_member.cascade_remove",
  reason: "by_owner" | "self" | "dormant" | "account_deleted",
  clearName: boolean,
): Promise<MemberRemovalResult> {
  await flow.transition(tx, ctx, {
    machine: "entity_member",
    stateField: "status",
    id: targetId,
    entityId,
    storeId: ctx.storeId,
    event,
    ref: "02:692",
    reasonCode: reason,
    set: {
      ...(clearName ? { display_name: null } : {}),
      removed_at: now,
      remove_actor_type: ctx.actor.type,
      remove_actor_id: ctx.actor.id,
      remove_client: ctx.actor.type === "system" ? null : "weapp",
      remove_reason: reason,
      last_store_id: null,
    },
    emit: {
      type: "entity_member.removed",
      payload: {
        v: 1,
        entityMemberId: targetId,
        entityId,
        merchantUserId: userId,
        role: "clerk",
        removeReason: reason,
      },
    },
  });
  await tx.storeMember.deleteMany({ where: { entityMemberId: targetId, entityId } });
  return { memberId: targetId, status: "removed", removedAt: now.toISOString() };
}
