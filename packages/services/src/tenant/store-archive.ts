// 老板停用门店：完整低锁图、真实阻断与同事务系统级联。
import type { StoreArchiveResult, StoreDeleteResult } from "@liyoxi/contract";
import type { Events } from "../events/index.js";
import type { Flow, Guard, TransitionFacts } from "../flow/index.js";
import { AppError, createIdentityContext, isUuid, lockRows } from "../kernel/index.js";
import type { Assembly, Clock, IdentityContext, MerchantFactsReader, Tx } from "../kernel/index.js";
import type { Timers } from "../timers/index.js";
import { readStoreCloseCounts } from "./close-facts.js";
import { resolveMembership } from "./membership.js";
import { listStores } from "./stores.js";

export interface StoreArchiveDeps {
  readonly assembly: Pick<Assembly, "port">;
  readonly clock: Clock;
  readonly flow: Flow;
  readonly facts: MerchantFactsReader;
  readonly timers: Pick<Timers, "cancel">;
  readonly events?: Pick<Events, "emit">;
  readonly readStoreDraftFacts?: StoreDraftFactsReader;
}
export interface StoreDraftFacts {
  readonly qualificationSubmissions: number;
  readonly orders: number;
  readonly ads: number;
  readonly channelAccounts: number;
  readonly serviceTickets: number;
  readonly originalAssets: number;
}
export type StoreDraftFactsReader = (
  tx: Tx,
  input: { entityId: string; storeId: string },
) => Promise<StoreDraftFacts>;
interface Prepared {
  readonly operation: "archive" | "delete";
  readonly deps: StoreArchiveDeps;
  readonly ctx: IdentityContext;
  readonly system: IdentityContext;
  readonly entityId: string;
  readonly storeId: string;
  readonly ownerId: string;
  readonly invitationIds: readonly string[];
  readonly removedIds: readonly string[];
}
const prepared = new WeakMap<Tx, Prepared>();

async function owner(tx: Tx, ctx: IdentityContext, ownerId?: string, after = false) {
  if (
    ctx.actor.type !== "merchant" ||
    ctx.actor.client !== "weapp" ||
    !ctx.entityId ||
    !ctx.storeId
  )
    throw new AppError("NOT_A_MEMBER");
  const [user, member] = await Promise.all([
    tx.merchantUser.findUnique({ where: { id: ctx.actor.id }, select: { status: true } }),
    resolveMembership(tx, { merchantUserId: ctx.actor.id, storeId: ctx.storeId }),
  ]);
  if (
    user?.status !== "active" ||
    !member ||
    member.entityId !== ctx.entityId ||
    (ownerId !== undefined && member.memberId !== ownerId)
  )
    throw new AppError("NOT_A_MEMBER");
  if (member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  if (!after && member.storeMode !== "active") throw new AppError("STORE_ARCHIVED");
  return member;
}
async function check(tx: Tx, state: Prepared) {
  await owner(tx, state.ctx, state.ownerId);
  const target = await tx.store.findUnique({ where: { id: state.storeId } });
  if (!target || target.entityId !== state.entityId || target.archiveReason === "draft_deleted")
    throw new AppError("NOT_FOUND");
  if (target.lifecycle !== "active") throw new AppError("STATE_NOT_ALLOWED");
  if ((await tx.store.count({ where: { entityId: state.entityId, lifecycle: "active" } })) <= 1)
    throw new AppError("LAST_ACTIVE_STORE");
  const counts = await readStoreCloseCounts(tx, state.deps.assembly, state.storeId);
  const blockers = Object.entries(counts)
    .map(([kind, count]) => {
      if (!Number.isSafeInteger(count) || count < 0) throw new AppError("INTERNAL");
      return { kind, count };
    })
    .filter(({ count }) => count > 0);
  if (blockers.length) throw new AppError("STORE_HAS_OPEN_WORK", { details: { blockers } });
  if (state.operation === "delete") {
    if (!state.deps.readStoreDraftFacts || !state.deps.events) throw new AppError("INTERNAL");
    const facts = await state.deps.readStoreDraftFacts(tx, {
      entityId: state.entityId,
      storeId: state.storeId,
    });
    const names = [
      "qualificationSubmissions",
      "orders",
      "ads",
      "channelAccounts",
      "serviceTickets",
      "originalAssets",
    ] as const;
    if (
      !facts ||
      Object.keys(facts).length !== names.length ||
      names.some(
        (name) =>
          !Object.hasOwn(facts, name) || !Number.isSafeInteger(facts[name]) || facts[name] < 0,
      )
    )
      throw new AppError("INTERNAL");
    const reasons = [
      ...(facts.qualificationSubmissions > 0 ? ["qualification_submitted"] : []),
      ...(names.slice(1).some((name) => facts[name] > 0) ? ["has_business_data"] : []),
    ];
    if (reasons.length) throw new AppError("STORE_NOT_DRAFT", { details: { reasons } });
  }
}
export const guardStoreArchive: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (
    !state ||
    facts.ctx !== state.ctx ||
    facts.machine !== "store" ||
    facts.stateField !== "lifecycle" ||
    facts.subjectId !== state.storeId ||
    facts.entityId !== state.entityId ||
    facts.storeId !== state.storeId ||
    facts.event !== (state.operation === "delete" ? "store.draft_delete" : "store.archive")
  )
    return false;
  await check(tx, state);
  return true;
};
/** 只有本事务真实 archive 完成主迁移后才能进行这两个系统分支。 */
export const guardStoreArchiveCascade: Guard = async (tx, facts: TransitionFacts) => {
  const state = prepared.get(tx);
  if (
    !state ||
    facts.ctx !== state.system ||
    facts.entityId !== state.entityId ||
    facts.ctx.actor.type !== "system"
  )
    return false;
  await owner(tx, state.ctx, state.ownerId, true);
  const store = await tx.store.findUnique({ where: { id: state.storeId } });
  if (
    store?.entityId !== state.entityId ||
    store.lifecycle !== "archived" ||
    store.archiveReason !== (state.operation === "delete" ? "draft_deleted" : "by_owner") ||
    !store.archivedAt
  )
    return false;
  if (
    facts.machine === "invitation" &&
    facts.event === "invitation.revoke" &&
    state.invitationIds.includes(facts.subjectId)
  ) {
    const row = await tx.invitation.findUnique({ where: { id: facts.subjectId } });
    return (
      row?.entityId === state.entityId && row.storeId === state.storeId && row.status === "pending"
    );
  }
  if (
    facts.machine === "entity_member" &&
    facts.event === "entity_member.cascade_remove" &&
    state.removedIds.includes(facts.subjectId)
  ) {
    const row = await tx.entityMember.findUnique({ where: { id: facts.subjectId } });
    const other = await tx.storeMember.count({
      where: { entityMemberId: facts.subjectId, store: { lifecycle: "active" } },
    });
    return (
      row?.entityId === state.entityId &&
      row.role === "clerk" &&
      row.status === "active" &&
      other === 0
    );
  }
  return false;
};

async function graph(tx: Tx, entityId: string, storeId: string) {
  const [invitations, members, stores, scopes] = await Promise.all([
    tx.invitation.findMany({
      where: { entityId, storeId, status: "pending" },
      orderBy: { id: "asc" },
    }),
    tx.entityMember.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    tx.store.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    tx.storeMember.findMany({
      where: { entityId },
      orderBy: [{ entityMemberId: "asc" }, { storeId: "asc" }],
    }),
  ]);
  return { invitations, members, stores, scopes };
}
function keys(value: Awaited<ReturnType<typeof graph>>) {
  return JSON.stringify({
    invitations: value.invitations.map((r) => r.id),
    members: value.members.map((r) => r.id),
    stores: value.stores.map((r) => r.id),
    scopes: value.scopes.map((r) => [r.entityMemberId, r.storeId]),
  });
}

export async function archiveStoreIn(
  tx: Tx,
  deps: StoreArchiveDeps,
  ctx: IdentityContext,
  storeId: string,
): Promise<StoreArchiveResult> {
  return changeStoreIn(tx, deps, ctx, storeId, "archive");
}
export async function deleteStoreIn(
  tx: Tx,
  deps: StoreArchiveDeps,
  ctx: IdentityContext,
  storeId: string,
): Promise<StoreDeleteResult> {
  return changeStoreIn(tx, deps, ctx, storeId, "delete");
}
function changeStoreIn(
  tx: Tx,
  deps: StoreArchiveDeps,
  ctx: IdentityContext,
  storeId: string,
  operation: "archive",
): Promise<StoreArchiveResult>;
function changeStoreIn(
  tx: Tx,
  deps: StoreArchiveDeps,
  ctx: IdentityContext,
  storeId: string,
  operation: "delete",
): Promise<StoreDeleteResult>;
async function changeStoreIn(
  tx: Tx,
  deps: StoreArchiveDeps,
  ctx: IdentityContext,
  storeId: string,
  operation: "archive" | "delete",
): Promise<StoreArchiveResult | StoreDeleteResult> {
  if (!ctx.entityId || !isUuid(ctx.entityId) || !ctx.storeId || ctx.actor.type !== "merchant")
    throw new AppError("NOT_A_MEMBER");
  if (!isUuid(storeId)) throw new AppError("NOT_FOUND");
  await lockRows(tx, "merchant_user", [ctx.actor.id]);
  await lockRows(tx, "entity", [ctx.entityId]);
  const operator = await owner(tx, ctx);
  const initial = await graph(tx, ctx.entityId, storeId);
  if (!initial.stores.some((row) => row.id === storeId)) throw new AppError("NOT_FOUND");
  await lockRows(
    tx,
    "invitation",
    initial.invitations.map((row) => row.id),
  );
  await lockRows(
    tx,
    "entity_member",
    initial.members.map((row) => row.id),
  );
  await lockRows(
    tx,
    "store",
    initial.stores.map((row) => row.id),
  );
  const current = await graph(tx, ctx.entityId, storeId);
  if (keys(initial) !== keys(current)) throw new AppError("PRECONDITION_CHANGED");
  const activeIds = new Set(
    current.stores
      .filter((row) => row.lifecycle === "active" && row.id !== storeId)
      .map((row) => row.id),
  );
  const affected = new Set(
    current.scopes.filter((row) => row.storeId === storeId).map((row) => row.entityMemberId),
  );
  const removed = current.members.filter(
    (row) =>
      row.status === "active" &&
      row.role === "clerk" &&
      affected.has(row.id) &&
      !current.scopes.some(
        (scope) => scope.entityMemberId === row.id && activeIds.has(scope.storeId),
      ),
  );
  const system = createIdentityContext({
    actor: {
      type: "system",
      job: operation === "delete" ? "tenant.store.draft_delete" : "tenant.store.archive",
    },
    entityId: ctx.entityId,
    storeId,
    requestId: ctx.requestId,
  });
  const state: Prepared = {
    operation,
    deps,
    ctx,
    system,
    entityId: ctx.entityId,
    storeId,
    ownerId: operator.memberId,
    invitationIds: current.invitations.map((row) => row.id),
    removedIds: removed.map((row) => row.id),
  };
  await check(tx, state);
  if (prepared.has(tx)) throw new AppError("INTERNAL");
  prepared.set(tx, state);
  const now = deps.clock.now();
  try {
    await deps.flow.transition(tx, ctx, {
      machine: "store",
      stateField: "lifecycle",
      id: storeId,
      entityId: ctx.entityId,
      storeId,
      event: operation === "delete" ? "store.draft_delete" : "store.archive",
      reasonCode: operation === "delete" ? "draft_deleted" : "by_owner",
      set: {
        archived_at: now,
        archive_actor_type: "merchant",
        archive_actor_id: ctx.actor.id,
        archive_client: "weapp",
        archive_reason: operation === "delete" ? "draft_deleted" : "by_owner",
      },
      emit: {
        type: "store.archived",
        payload: {
          v: 1,
          storeId,
          entityId: ctx.entityId,
          archiveReason: operation === "delete" ? "draft_deleted" : "by_owner",
        },
      },
    });
    for (const row of current.invitations) {
      await deps.flow.transition(tx, system, {
        machine: "invitation",
        stateField: "status",
        id: row.id,
        entityId: ctx.entityId,
        storeId,
        event: "invitation.revoke",
        reasonCode: "store_archived",
        set: {
          revoked_at: now,
          revoke_actor_type: "system",
          revoke_actor_id: null,
          revoke_client: null,
          revoke_reason: "store_archived",
          token_enc: null,
        },
        emit: {
          type: "invitation.revoked",
          payload: { v: 1, invitationId: row.id, entityId: ctx.entityId, storeId },
        },
      });
      await deps.timers.cancel(tx, {
        subject: { type: "invitation", id: row.id },
        kinds: ["invitation.expire"],
      });
    }
    await tx.storeMember.deleteMany({ where: { entityId: ctx.entityId, storeId } });
    for (const row of removed) {
      await deps.flow.transition(tx, system, {
        machine: "entity_member",
        stateField: "status",
        id: row.id,
        entityId: ctx.entityId,
        storeId,
        event: "entity_member.cascade_remove",
        ref: "02:692",
        reasonCode: "store_archived",
        set: {
          removed_at: now,
          remove_actor_type: "system",
          remove_actor_id: null,
          remove_client: null,
          remove_reason: "store_archived",
          last_store_id: null,
        },
        emit: {
          type: "entity_member.removed",
          payload: {
            v: 1,
            entityMemberId: row.id,
            entityId: ctx.entityId,
            merchantUserId: row.merchantUserId,
            role: "clerk",
            removeReason: "store_archived",
          },
        },
      });
      await tx.storeMember.deleteMany({
        where: { entityId: ctx.entityId, entityMemberId: row.id },
      });
    }
    await tx.entityMember.updateMany({
      where: { entityId: ctx.entityId, lastStoreId: storeId },
      data: { lastStoreId: null, updatedAt: now },
    });
    if (operation === "delete") {
      await deps.events!.emit(tx, ctx, {
        type: "store.draft_deleted",
        aggregate: { type: "store", id: storeId },
        payload: { v: 1, storeId, entityId: ctx.entityId },
      });
      return { storeId, deletedAt: now.toISOString() };
    }
    const list = await listStores(tx, { facts: deps.facts }, deps.clock.now(), {
      merchantUserId: ctx.actor.id,
    });
    const card =
      list.viewerRole === "owner" ? list.items.find((row) => row.storeId === storeId) : null;
    if (!card) throw new AppError("INTERNAL");
    return {
      store: card,
      revokedInvitationCount: current.invitations.length,
      removedMemberCount: removed.length,
    };
  } finally {
    prepared.delete(tx);
  }
}
