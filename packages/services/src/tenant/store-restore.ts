// 恢复老板停用的门店：锁后现算额度，私有事务见证只开放这一条迁移。
import type { StoreCard } from "@liyoxi/contract";
import type { Flow, Guard } from "../flow/index.js";
import { AppError, isUuid, lockRows } from "../kernel/index.js";
import type { Clock, IdentityContext, MerchantFactsReader, Tx } from "../kernel/index.js";
import { resolveMembership } from "./membership.js";
import { getQuotaUsage } from "./quota.js";
import { listStores } from "./stores.js";

interface RestoreDeps {
  readonly clock: Clock;
  readonly flow: Flow;
  readonly facts: MerchantFactsReader;
}
interface Prepared {
  readonly deps: RestoreDeps;
  readonly ctx: IdentityContext;
  readonly entityId: string;
  readonly memberId: string;
  readonly storeId: string;
}
const prepared = new WeakMap<Tx, Prepared>();

async function owner(tx: Tx, ctx: IdentityContext, memberId?: string) {
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
    (memberId !== undefined && member.memberId !== memberId)
  )
    throw new AppError("NOT_A_MEMBER");
  if (member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  return member;
}

async function check(tx: Tx, state: Prepared) {
  await owner(tx, state.ctx, state.memberId);
  const target = await tx.store.findUnique({ where: { id: state.storeId } });
  if (!target || target.entityId !== state.entityId || target.archiveReason === "draft_deleted")
    throw new AppError("NOT_FOUND");
  if (target.lifecycle !== "archived" || target.archiveReason !== "by_owner")
    throw new AppError("STATE_NOT_ALLOWED");
  // 额度事实只经既有读口取得；等待结束后的业务时钟不能沿用锁前值。
  const usage = await getQuotaUsage(
    tx,
    { facts: state.deps.facts },
    state.deps.clock.now(),
    state.entityId,
  );
  if (
    !Number.isSafeInteger(usage.storesUsed) ||
    usage.storesUsed < 0 ||
    !Number.isSafeInteger(usage.storeLimit) ||
    usage.storeLimit < 0
  )
    throw new AppError("INTERNAL");
  if (usage.storesUsed + 1 > usage.storeLimit)
    throw new AppError("STORE_LIMIT_REACHED", {
      details: {
        storesUsed: usage.storesUsed,
        storeLimit: usage.storeLimit,
        limitReason: usage.limitReason,
      },
    });
}

export const guardStoreRestore: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (
    !state ||
    facts.ctx !== state.ctx ||
    facts.machine !== "store" ||
    facts.stateField !== "lifecycle" ||
    facts.subjectId !== state.storeId ||
    facts.entityId !== state.entityId ||
    facts.storeId !== state.storeId ||
    facts.event !== "store.restore"
  )
    return false;
  await check(tx, state);
  return true;
};

export async function restoreStoreIn(
  tx: Tx,
  deps: RestoreDeps,
  ctx: IdentityContext,
  storeId: string,
): Promise<StoreCard> {
  if (!ctx.entityId || !isUuid(ctx.entityId) || !ctx.storeId || ctx.actor.type !== "merchant")
    throw new AppError("NOT_A_MEMBER");
  if (!isUuid(storeId)) throw new AppError("NOT_FOUND");
  await lockRows(tx, "merchant_user", [ctx.actor.id]);
  await lockRows(tx, "entity", [ctx.entityId]);
  const operator = await owner(tx, ctx);
  await lockRows(tx, "entity_member", [operator.memberId]);
  await lockRows(tx, "store", [...new Set([ctx.storeId, storeId])].sort());
  const state: Prepared = {
    deps,
    ctx,
    entityId: ctx.entityId,
    memberId: operator.memberId,
    storeId,
  };
  await check(tx, state);
  if (prepared.has(tx)) throw new AppError("INTERNAL");
  prepared.set(tx, state);
  try {
    await deps.flow.transition(tx, ctx, {
      machine: "store",
      stateField: "lifecycle",
      id: storeId,
      entityId: ctx.entityId,
      storeId,
      event: "store.restore",
      set: {
        archived_at: null,
        archive_actor_type: null,
        archive_actor_id: null,
        archive_client: null,
        archive_reason: null,
      },
      emit: {
        type: "store.restored",
        payload: { v: 1, storeId, entityId: ctx.entityId },
      },
    });
    const list = await listStores(tx, { facts: deps.facts }, deps.clock.now(), {
      merchantUserId: ctx.actor.id,
    });
    const card =
      list.viewerRole === "owner" ? list.items.find((row) => row.storeId === storeId) : null;
    if (!card) throw new AppError("INTERNAL");
    return card;
  } finally {
    prepared.delete(tx);
  }
}
