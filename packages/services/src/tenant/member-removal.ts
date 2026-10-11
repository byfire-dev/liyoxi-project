// W2-10：老板移除店员与本人退出，共用原事务、锁序与成员状态机。
import type { MemberRemovalResult } from "@liyoxi/contract";
import type { Flow, Guard } from "../flow/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
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
    await flow.transition(tx, ctx, {
      machine: "entity_member",
      stateField: "status",
      id: target.id,
      entityId,
      storeId: ctx.storeId,
      event: input.event,
      reasonCode: reason,
      set: {
        removed_at: now,
        remove_actor_type: "merchant",
        remove_actor_id: ctx.actor.id,
        remove_client: "weapp",
        remove_reason: reason,
        last_store_id: null,
      },
      emit: {
        type: "entity_member.removed",
        payload: {
          v: 1,
          entityMemberId: target.id,
          entityId,
          merchantUserId: target.merchantUserId,
          role: "clerk",
          removeReason: reason,
        },
      },
    });
    await tx.storeMember.deleteMany({ where: { entityMemberId: target.id, entityId } });
    return { memberId: target.id, status: "removed", removedAt: now.toISOString() };
  } finally {
    prepared.delete(tx);
  }
}
