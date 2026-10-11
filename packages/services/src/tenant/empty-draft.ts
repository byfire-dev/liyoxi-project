import type { Flow } from "../flow/index.js";
import type { Assembly, IdentityContext, Tx } from "../kernel/index.js";
import { billingHistoryPort, membershipAuthorizationsPort } from "./ports.js";

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

/** 仅真实 accept 的私有 same-Tx witness 能通过首个及后续 flow 守卫。 */
export async function abandonDraftIn(
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
