import type { Flow, Guard } from "../flow/index.js";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Assembly, Clock, IdentityContext, Tx } from "../kernel/index.js";
import { billingHistoryPort, membershipAuthorizationsPort } from "./ports.js";
import { selectActiveMembership } from "./repo.js";

/** 仅四项实际事实；这个只读结果本身不是放弃权限。 */
export async function emptyDraftFacts(
  tx: Tx,
  assembly: Pick<Assembly, "port">,
  entityId: string,
  ownerId: string,
  userId: string,
) {
  const [entity, owner, others, pending, history] = await Promise.all([
    tx.entity.findUnique({ where: { id: entityId } }),
    tx.entityMember.findUnique({ where: { id: ownerId } }),
    tx.entityMember.count({ where: { entityId, status: "active", NOT: { id: ownerId } } }),
    tx.invitation.count({ where: { entityId, status: "pending" } }),
    assembly.port(billingHistoryPort).read(tx, entityId),
  ]);
  return (
    entity?.lifecycle === "active" &&
    entity.verificationStatus === "unsubmitted" &&
    owner?.entityId === entityId &&
    owner.merchantUserId === userId &&
    owner.role === "owner" &&
    owner.status === "active" &&
    others === 0 &&
    pending === 0 &&
    history.hasSubscriptionTerm === false &&
    history.hasBillingOrder === false
  );
}

export interface DraftAbandonResult {
  readonly entityId: string;
  readonly memberId: string;
  readonly storeIds: readonly string[];
}
/** 仅表示锁后真实四项草稿事实不满足；依赖和状态机错误不归入此类。 */
export class DraftNotEmptyError extends AppError {
  constructor() {
    super("STATE_NOT_ALLOWED");
  }
}
type DraftDeps = { flow: Flow; assembly: Pick<Assembly, "port">; clock: Clock };
type DraftPlan = { entityId: string; ownerId: string; userId: string; storeIds: string[] };
const prepared = new WeakMap<Tx, { deps: DraftDeps; ctx: IdentityContext; plan: DraftPlan }>();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function graph(tx: Tx, entityId: string) {
  const [invitations, members, stores] = await Promise.all([
    tx.invitation.findMany({ where: { entityId }, orderBy: { id: "asc" }, select: { id: true } }),
    tx.entityMember.findMany({ where: { entityId }, orderBy: { id: "asc" }, select: { id: true } }),
    tx.store.findMany({ where: { entityId }, orderBy: { id: "asc" }, select: { id: true } }),
  ]);
  return {
    invitations: invitations.map((r) => r.id),
    members: members.map((r) => r.id),
    stores: stores.map((r) => r.id),
  };
}
export const guardDraftAbandon: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (!state || facts.ctx !== state.ctx || facts.entityId !== state.plan.entityId) return false;
  const { plan } = state;
  if (facts.machine === "entity" && facts.event === "entity.abandon") {
    const user = await tx.merchantUser.findUnique({ where: { id: plan.userId } });
    return (
      facts.subjectId === plan.entityId &&
      user?.status === "active" &&
      (await emptyDraftFacts(tx, state.deps.assembly, plan.entityId, plan.ownerId, plan.userId))
    );
  }
  const entity = await tx.entity.findUnique({ where: { id: plan.entityId } });
  return (
    entity?.lifecycle === "abandoned" &&
    entity.closedAt !== null &&
    ((facts.machine === "entity_member" &&
      facts.event === "entity_member.cascade_remove" &&
      facts.subjectId === plan.ownerId) ||
      (facts.machine === "store" &&
        facts.event === "store.archive_by_entity" &&
        plan.storeIds.includes(facts.subjectId)))
  );
};

/** 本人当前空草稿；身份认证及休眠五条件由调用方拥有，本域只签发真实同Tx事实见证。 */
export async function abandonDraftIn(
  tx: Tx,
  deps: DraftDeps,
  ctx: IdentityContext,
): Promise<DraftAbandonResult> {
  if (ctx.actor.type !== "merchant" || ctx.actor.client !== "weapp")
    throw new AppError("ROLE_FORBIDDEN");
  if (prepared.has(tx)) throw new AppError("INTERNAL");
  const userId = ctx.actor.id;
  await lockRows(tx, "merchant_user", [userId]);
  const user = await tx.merchantUser.findUnique({ where: { id: userId } });
  const member = await selectActiveMembership(tx, userId);
  if (user?.status !== "active" || !member) throw new AppError("NOT_A_MEMBER");
  if (member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  await lockRows(tx, "entity", [member.entityId]);
  const before = await graph(tx, member.entityId);
  await lockRows(tx, "invitation", before.invitations);
  await lockRows(tx, "entity_member", before.members);
  await lockRows(tx, "store", before.stores);
  if (!same(before, await graph(tx, member.entityId))) throw new AppError("PRECONDITION_CHANGED");
  if (!(await emptyDraftFacts(tx, deps.assembly, member.entityId, member.memberId, userId)))
    throw new DraftNotEmptyError();
  const plan = {
    entityId: member.entityId,
    ownerId: member.memberId,
    userId,
    storeIds: before.stores,
  };
  const system = createIdentityContext({
    actor: { type: "system", job: "tenant.abandon_draft" },
    entityId: member.entityId,
    requestId: ctx.requestId,
  });
  prepared.set(tx, { deps, ctx: system, plan });
  try {
    await abandonPrepared(tx, deps, system, plan, deps.clock.now());
    return { entityId: plan.entityId, memberId: plan.ownerId, storeIds: plan.storeIds };
  } finally {
    prepared.delete(tx);
  }
}

/** 唯一让位级联执行段；只能由上方真实命令在私有见证存续期间调用。 */
async function abandonPrepared(
  tx: Tx,
  deps: { flow: Flow; assembly: Pick<Assembly, "port"> },
  ctx: IdentityContext,
  input: { entityId: string; ownerId: string; userId: string; storeIds: string[] },
  now: Date,
) {
  const { entityId, ownerId, userId } = input;
  await deps.flow.transition(tx, ctx, {
    machine: "entity",
    stateField: "lifecycle",
    id: entityId,
    entityId,
    event: "entity.abandon",
    ref: "02:524",
    set: { closed_at: now },
    emit: { type: "entity.abandoned", payload: { v: 1, entityId } },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "entity_member",
    stateField: "status",
    id: ownerId,
    entityId,
    event: "entity_member.cascade_remove",
    ref: "02:695",
    reasonCode: "draft_abandoned",
    set: {
      removed_at: now,
      remove_actor_type: "system",
      remove_actor_id: null,
      remove_client: null,
      remove_reason: "draft_abandoned",
      last_store_id: null,
    },
    emit: {
      type: "entity_member.removed",
      payload: {
        v: 1,
        entityMemberId: ownerId,
        entityId,
        merchantUserId: userId,
        role: "owner",
        removeReason: "draft_abandoned",
      },
    },
  });
  await tx.storeMember.deleteMany({ where: { entityMemberId: ownerId } });
  for (const id of input.storeIds) {
    const store = await tx.store.findUniqueOrThrow({ where: { id } });
    if (store.lifecycle !== "active") continue;
    await deps.flow.transition(tx, ctx, {
      machine: "store",
      stateField: "lifecycle",
      id,
      entityId,
      storeId: id,
      event: "store.archive_by_entity",
      ref: "02:611",
      reasonCode: "entity_abandoned",
      set: {
        archived_at: now,
        archive_actor_type: "system",
        archive_actor_id: null,
        archive_client: null,
        archive_reason: "entity_abandoned",
      },
      emit: {
        type: "store.archived",
        payload: { v: 1, entityId, storeId: id, archiveReason: "entity_abandoned" },
      },
    });
    await tx.storeMember.deleteMany({ where: { storeId: id } });
  }
  await deps.assembly
    .port(membershipAuthorizationsPort)
    .revokePortalGrants(tx, { scope: "owner", entityId, merchantUserId: userId, now });
}
