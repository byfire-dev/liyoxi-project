import { assertPermission, entityScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Flow, TransitionFacts } from "../flow/index.js";
import { actorColumns, AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Assembly, Clock, IdentityContext, Tx } from "../kernel/index.js";
import type { Timers } from "../timers/index.js";
import { readEntityDeletionCounts } from "./close-facts.js";
import { entityAdCancelClosePort, membershipAuthorizationsPort } from "./ports.js";
import type { EntityAdCancelClosePlan } from "./ports.js";

export interface CloseEntityDeps {
  readonly assembly: Assembly;
  readonly clock: Clock;
  readonly flow: Flow;
  readonly timers: Pick<Timers, "cancel">;
}
export interface CloseEntityActor {
  readonly ctx: IdentityContext;
  readonly staff: StaffContext;
}
export interface CloseEntityInput {
  readonly entityId: string;
  readonly reasonText: string;
  readonly confirm: { readonly activeStoreCount: number; readonly activeMemberCount: number };
}
export interface CloseEntityResult {
  readonly entityId: string;
  readonly lifecycle: "closed";
  readonly invitationIds: readonly string[];
  readonly memberIds: readonly string[];
  readonly storeIds: readonly string[];
  readonly withdrawnCancelRequestIds: readonly string[];
  readonly revokedPortalGrantCount: number;
}
type TenantClosePlan = Pick<
  EntityAdCancelClosePlan,
  "entityId" | "invitationIds" | "memberIds" | "storeIds"
>;
type Prepared = { readonly deps: CloseEntityDeps } & (
  | {
      readonly kind: "staff";
      readonly actor: CloseEntityActor;
      readonly input: CloseEntityInput;
      readonly plan: EntityAdCancelClosePlan;
    }
  | {
      readonly kind: "owner";
      readonly actor: { ctx: IdentityContext };
      readonly input: { entityId: string; reasonText: string };
      readonly plan: TenantClosePlan;
      readonly ownerId: string;
    }
);
// Only the real owner entry sets this after the complete low-lock prepare succeeds.
// Flow args and caller booleans cannot grant cascade authority.
const prepared = new WeakMap<Tx, Prepared>();
async function checkClose(tx: Tx, state: Prepared) {
  const { actor, deps, input } = state;
  if (state.kind === "staff") {
    const { actor, input } = state;
    assertPermission(actor.staff, "merchant.entity.close", deps.clock.now());
    const staff = await tx.staff.findUnique({
      where: { id: actor.staff.staff.id },
      select: { status: true, staffRoleKey: true, staffGroupId: true, isLead: true },
    });
    if (
      staff?.status !== "active" ||
      staff.staffRoleKey !== actor.staff.staff.roleKey ||
      staff.staffGroupId !== actor.staff.staff.staffGroupId ||
      staff.isLead !== actor.staff.staff.isLead
    )
      throw new AppError("PERMISSION_DENIED");
    const entity = await tx.entity.findFirst({
      where: { id: input.entityId, ...entityScope(actor.staff.scope) },
      select: { lifecycle: true },
    });
    if (!entity) throw new AppError("NOT_FOUND");
    if (entity.lifecycle !== "active") throw new AppError("STATE_NOT_ALLOWED");
  } else {
    const { ctx } = actor;
    if (ctx.actor.type !== "merchant" || ctx.actor.client !== "weapp")
      throw new AppError("ROLE_FORBIDDEN");
    const [user, member, entity] = await Promise.all([
      tx.merchantUser.findUnique({ where: { id: ctx.actor.id } }),
      tx.entityMember.findUnique({ where: { id: state.ownerId } }),
      tx.entity.findUnique({ where: { id: input.entityId } }),
    ]);
    if (
      user?.status !== "active" ||
      member?.merchantUserId !== ctx.actor.id ||
      member.entityId !== input.entityId ||
      member.role !== "owner" ||
      member.status !== "active"
    )
      throw new AppError("PRECONDITION_CHANGED");
    if (entity?.lifecycle !== "active") throw new AppError("STATE_NOT_ALLOWED");
  }
  const counts = await readEntityDeletionCounts(tx, deps.assembly, input.entityId);
  const blockers = Object.entries(counts)
    .map(([kind, count]) => {
      if (!Number.isSafeInteger(count) || count < 0) throw new AppError("INTERNAL");
      return { kind, count };
    })
    .filter(({ count }) => count > 0);
  if (blockers.length)
    throw new AppError(
      state.kind === "staff" ? "ENTITY_CLOSE_BLOCKED" : "ACCOUNT_DELETION_BLOCKED",
      { details: { blockers } },
    );
  if (state.kind !== "staff") return;
  const [activeStoreCount, activeMemberCount] = await Promise.all([
    tx.store.count({ where: { entityId: input.entityId, lifecycle: "active" } }),
    tx.entityMember.count({ where: { entityId: input.entityId, status: "active" } }),
  ]);
  if (
    state.input.confirm.activeStoreCount !== activeStoreCount ||
    state.input.confirm.activeMemberCount !== activeMemberCount
  )
    throw new AppError("CONFIRM_MISMATCH");
}
function witness(tx: Tx, facts: TransitionFacts) {
  const state = prepared.get(tx);
  return state?.actor.ctx === facts.ctx && state.input.entityId === facts.entityId ? state : null;
}
/** The entity guard repeats the actual six owner facts and current authorization. */
export async function guardEntityClose(tx: Tx, facts: TransitionFacts): Promise<boolean> {
  const state = witness(tx, facts);
  if (!state || facts.subjectId !== state.input.entityId) return false;
  await checkClose(tx, state);
  return true;
}
/** Cascades require both the nonforgeable same-Tx call and a genuinely closed entity. */
export async function guardEntityCloseCascade(tx: Tx, facts: TransitionFacts): Promise<boolean> {
  const state = witness(tx, facts);
  if (!state) return false;
  const ids =
    facts.machine === "invitation"
      ? state.plan.invitationIds
      : facts.machine === "entity_member"
        ? state.plan.memberIds
        : state.plan.storeIds;
  if (!ids.includes(facts.subjectId)) return false;
  const entity = await tx.entity.findUnique({
    where: { id: state.input.entityId },
    select: { lifecycle: true, closedAt: true },
  });
  return entity?.lifecycle === "closed" && entity.closedAt !== null;
}
export async function requireClosedStoreCascade(tx: Tx, facts: TransitionFacts): Promise<void> {
  if (!(await guardEntityCloseCascade(tx, facts))) throw new AppError("PRECONDITION_CHANGED");
}

/** Internal staff-close owner command. The caller owns the transaction/idempotency boundary. */
export async function closeEntityIn(
  tx: Tx,
  deps: CloseEntityDeps,
  actor: CloseEntityActor,
  input: CloseEntityInput,
): Promise<CloseEntityResult> {
  if (actor.ctx.actor.type !== "staff" || actor.ctx.actor.id !== actor.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertPermission(actor.staff, "merchant.entity.close", deps.clock.now());
  input = Object.freeze({ ...input, confirm: Object.freeze({ ...input.confirm }) });
  if ([...input.reasonText.trim()].length < 10 || [...input.reasonText.trim()].length > 200)
    throw new AppError("VALIDATION_FAILED");
  if (prepared.has(tx)) throw new AppError("INTERNAL");
  if (
    !(await tx.entity.findFirst({
      where: { id: input.entityId, ...entityScope(actor.staff.scope) },
      select: { id: true },
    }))
  )
    throw new AppError("NOT_FOUND");
  const closer = deps.assembly.port(entityAdCancelClosePort);
  // This is the first lock-taking call: staff20/approval30/cancel50/line60 -> tenant100..130.
  const plan = await closer.prepare(tx, input.entityId, [actor.staff.staff.id]);
  const state: Prepared = { kind: "staff", actor, deps, input, plan };
  await checkClose(tx, state);
  return executeClose(tx, state);
}

/** 本人注销的tenant联动；账号/身份/审批最终清理由identity外层事务拥有。 */
export async function closeEntityForOwnerDeletionIn(
  tx: Tx,
  deps: CloseEntityDeps,
  ctx: IdentityContext,
): Promise<CloseEntityResult> {
  if (ctx.actor.type !== "merchant" || ctx.actor.client !== "weapp")
    throw new AppError("ROLE_FORBIDDEN");
  if (prepared.has(tx)) throw new AppError("INTERNAL");
  await lockRows(tx, "merchant_user", [ctx.actor.id]);
  const user = await tx.merchantUser.findUnique({ where: { id: ctx.actor.id } });
  const owner = await tx.entityMember.findFirst({
    where: { merchantUserId: ctx.actor.id, status: "active" },
  });
  if (user?.status !== "active" || !owner) throw new AppError("NOT_A_MEMBER");
  if (owner.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  await lockRows(tx, "entity", [owner.entityId]);
  const plan = await ownerGraph(tx, owner.entityId);
  await lockRows(tx, "invitation", plan.invitationIds);
  await lockRows(tx, "entity_member", plan.memberIds);
  await lockRows(tx, "store", plan.storeIds);
  if (JSON.stringify(plan) !== JSON.stringify(await ownerGraph(tx, owner.entityId)))
    throw new AppError("PRECONDITION_CHANGED");
  const actor = {
    ctx: createIdentityContext({
      ...ctx,
      actor: ctx.actor,
      entityId: owner.entityId,
      storeId: null,
    }),
  };
  const state: Prepared = {
    kind: "owner",
    actor,
    deps,
    input: { entityId: owner.entityId, reasonText: "本人注销账号，关闭经营主体" },
    plan,
    ownerId: owner.id,
  };
  await checkClose(tx, state);
  return executeClose(tx, state);
}
async function ownerGraph(tx: Tx, entityId: string): Promise<TenantClosePlan> {
  const [invitations, members, stores] = await Promise.all([
    tx.invitation.findMany({ where: { entityId }, orderBy: { id: "asc" }, select: { id: true } }),
    tx.entityMember.findMany({ where: { entityId }, orderBy: { id: "asc" }, select: { id: true } }),
    tx.store.findMany({ where: { entityId }, orderBy: { id: "asc" }, select: { id: true } }),
  ]);
  return {
    entityId,
    invitationIds: invitations.map((r) => r.id),
    memberIds: members.map((r) => r.id),
    storeIds: stores.map((r) => r.id),
  };
}
/** 两入口共用的唯一tenant状态级联，后台取消收尾只在staff分支调用。 */
async function executeClose(tx: Tx, state: Prepared): Promise<CloseEntityResult> {
  const { actor, deps, input, plan } = state;
  const grants = deps.assembly.port(membershipAuthorizationsPort);
  const [invitations, members, stores] = await Promise.all([
    tx.invitation.findMany({
      where: { entityId: input.entityId, status: "pending" },
      orderBy: { id: "asc" },
    }),
    tx.entityMember.findMany({
      where: { entityId: input.entityId, status: "active" },
      orderBy: { id: "asc" },
    }),
    tx.store.findMany({
      where: { entityId: input.entityId, lifecycle: "active" },
      orderBy: { id: "asc" },
    }),
  ]);
  if (
    invitations.some((r) => !plan.invitationIds.includes(r.id)) ||
    members.some((r) => !plan.memberIds.includes(r.id)) ||
    stores.some((r) => !plan.storeIds.includes(r.id))
  )
    throw new AppError("PRECONDITION_CHANGED");
  prepared.set(tx, state);
  const now = deps.clock.now(),
    columns = actorColumns(actor.ctx.actor);
  const common = { entityId: input.entityId, note: input.reasonText.trim() };
  try {
    // Child cascade guards require the real closed state, so close first in this same Tx.
    await deps.flow.transition(tx, actor.ctx, {
      ...common,
      machine: "entity",
      stateField: "lifecycle",
      id: input.entityId,
      event: "entity.close",
      set: { closed_at: now },
      audit: {
        stream: "ops",
        category: state.kind === "staff" ? "merchant_lifecycle" : "account_security",
        action: "tenant.entity.close",
        summary: "关闭经营主体",
        entityId: input.entityId,
        target: { type: "entity", id: input.entityId },
        reason: {
          code: state.kind === "staff" ? "staff_close" : "owner_deletion",
          text: input.reasonText.trim(),
        },
        ...(state.kind === "staff" ? { meta: { confirm: { ...state.input.confirm } } } : {}),
      },
      emit: {
        type: "entity.closed",
        payload: {
          v: 1,
          entityId: input.entityId,
          closedBy: state.kind === "staff" ? "staff_close" : "owner_deletion",
        },
      },
    });
    for (const row of invitations) {
      await deps.flow.transition(tx, actor.ctx, {
        ...common,
        machine: "invitation",
        stateField: "status",
        id: row.id,
        storeId: row.storeId,
        event: "invitation.revoke",
        reasonCode: "entity_closed",
        set: {
          revoked_at: now,
          revoke_actor_type: columns.actorType,
          revoke_actor_id: columns.actorId,
          revoke_client: columns.client,
          revoke_reason: "entity_closed",
          token_enc: null,
        },
        emit: {
          type: "invitation.revoked",
          payload: { v: 1, invitationId: row.id, entityId: input.entityId, storeId: row.storeId },
        },
      });
      await deps.timers.cancel(tx, {
        subject: { type: "invitation", id: row.id },
        kinds: ["invitation.expire"],
      });
    }
    for (const row of members) {
      const reason =
        state.kind === "owner" && row.id === state.ownerId ? "account_deleted" : "entity_closed";
      await deps.flow.transition(tx, actor.ctx, {
        ...common,
        machine: "entity_member",
        stateField: "status",
        id: row.id,
        event: "entity_member.cascade_remove",
        reasonCode: reason,
        ref: row.role === "owner" ? "02:695" : "02:692",
        set: {
          ...(reason === "account_deleted" ? { display_name: null } : {}),
          removed_at: now,
          remove_actor_type: columns.actorType,
          remove_actor_id: columns.actorId,
          remove_client: columns.client,
          remove_reason: reason,
          last_store_id: null,
        },
        emit: {
          type: "entity_member.removed",
          payload: {
            v: 1,
            entityMemberId: row.id,
            entityId: input.entityId,
            merchantUserId: row.merchantUserId,
            role: row.role === "owner" ? "owner" : "clerk",
            removeReason: reason,
          },
        },
      });
      await tx.storeMember.deleteMany({ where: { entityMemberId: row.id } });
    }
    for (const row of stores)
      await deps.flow.transition(tx, actor.ctx, {
        ...common,
        machine: "store",
        stateField: "lifecycle",
        id: row.id,
        storeId: row.id,
        event: "store.archive_by_entity",
        reasonCode: "entity_closed",
        ref: "02:610",
        set: {
          archived_at: now,
          archive_actor_type: columns.actorType,
          archive_actor_id: columns.actorId,
          archive_client: columns.client,
          archive_reason: "entity_closed",
        },
        emit: {
          type: "store.archived",
          payload: {
            v: 1,
            storeId: row.id,
            entityId: input.entityId,
            archiveReason: "entity_closed",
          },
        },
      });
    const revokedPortalGrantCount = await grants.revokePortalGrants(tx, {
      scope: "entity",
      entityId: input.entityId,
      now,
    });
    const withdrawnCancelRequestIds =
      state.kind === "staff"
        ? await deps.assembly.port(entityAdCancelClosePort).withdraw(tx, actor.ctx, state.plan)
        : [];
    return {
      entityId: input.entityId,
      lifecycle: "closed",
      invitationIds: invitations.map((r) => r.id),
      memberIds: members.map((r) => r.id),
      storeIds: stores.map((r) => r.id),
      withdrawnCancelRequestIds,
      revokedPortalGrantCount,
    };
  } finally {
    prepared.delete(tx);
  }
}
