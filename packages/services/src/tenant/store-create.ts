// 分店创建：外检不持锁，完整写图内使用实际拥有者，事务私有凭据不由调用者构造。
import { StoreCreateBodySchema } from "@liyoxi/contract";
import type { StoreCard, StoreCreateBody } from "@liyoxi/contract";
import type { Flow, Guard } from "../flow/index.js";
import {
  AppError,
  createThreePhaseRunner,
  createIdentityContext,
  lockRows,
  uuidv7,
} from "../kernel/index.js";
import type {
  Clock,
  IdentityContext,
  IdempotencyContext,
  MerchantFactsReader,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import { resolveMembership } from "./membership.js";
import { getQuotaUsage } from "./quota.js";
import { listStores } from "./stores.js";

/** 本域结构端口；API 固定传入真实 identity principal，不引入同层生产依赖。 */
export interface StoreCreatePrincipal {
  readonly sessionId: string;
  readonly merchantUserId: string;
  readonly wechatIdentityId: string;
  readonly consentStamp: string | null;
}
export interface StoreCreation {
  assertSession(tx: Tx, principal: StoreCreatePrincipal, freshNow: Date): Promise<void>;
  validateBasics(
    ctx: IdentityContext,
    principal: StoreCreatePrincipal,
    body: StoreCreateBody,
  ): Promise<void>;
  initialize(
    tx: Tx,
    ctx: IdentityContext,
    principal: StoreCreatePrincipal,
    input: {
      readonly contextStoreId: string;
      readonly targetStoreId: string;
      readonly copyFromStoreId: string | null;
      readonly copyOptions: readonly ("basic" | "service" | "media" | "brand_assets")[];
      readonly initial: {
        readonly addressDetail: string;
        readonly industryCode: string;
        readonly categoryCode: string;
      };
    },
  ): Promise<void>;
}
export interface StoreCreateOptions {
  readonly idem?: IdempotencyContext;
  readonly principal: StoreCreatePrincipal;
}
interface Deps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly flow: Flow;
  readonly facts: MerchantFactsReader;
  readonly storeCreation?: StoreCreation;
}
interface State {
  readonly deps: Deps;
  readonly ports: StoreCreation;
  readonly ctx: IdentityContext;
  readonly principal: StoreCreatePrincipal;
  readonly body: StoreCreateBody;
  readonly memberId: string;
  readonly targetId: string;
  inserted: boolean;
  initialized: boolean;
}
const prepared = new WeakMap<Tx, State>();
const invalid = () => new AppError("VALIDATION_FAILED");
async function owner(
  tx: Tx,
  ctx: IdentityContext,
  principal: StoreCreatePrincipal,
  memberId?: string,
) {
  if (
    ctx.actor.type !== "merchant" ||
    ctx.actor.client !== "weapp" ||
    ctx.actor.id !== principal.merchantUserId ||
    !ctx.entityId ||
    !ctx.storeId
  )
    throw new AppError("NOT_A_MEMBER");
  const user = await tx.merchantUser.findUnique({
    where: { id: principal.merchantUserId },
    select: { status: true },
  });
  const member = await resolveMembership(tx, {
    merchantUserId: principal.merchantUserId,
    storeId: ctx.storeId,
  });
  if (
    user?.status !== "active" ||
    !member ||
    member.entityId !== ctx.entityId ||
    (memberId !== undefined && member.memberId !== memberId)
  )
    throw new AppError("NOT_A_MEMBER");
  if (member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  if (member.storeMode !== "active") throw new AppError("STORE_ARCHIVED");
  return member;
}
async function current(tx: Tx, state: State) {
  const { ctx, body, principal, deps, ports } = state;
  await owner(tx, ctx, principal, state.memberId);
  if (body.copyFromStoreId) {
    const source = await tx.store.findUnique({ where: { id: body.copyFromStoreId } });
    if (
      !source ||
      source.entityId !== ctx.entityId ||
      source.archiveReason === "draft_deleted" ||
      (source.lifecycle !== "active" && source.archiveReason !== "by_owner")
    )
      throw invalid();
  }
  if (state.inserted) {
    const target = await tx.store.findUnique({ where: { id: state.targetId } });
    if (
      !target ||
      target.entityId !== ctx.entityId ||
      target.isPrimary ||
      target.lifecycle !== "active" ||
      target.qualificationStatus !== "unsubmitted" ||
      target.name !== body.name
    )
      throw new AppError("STATE_NOT_ALLOWED");
    if (state.initialized) {
      const profile = await tx.storeProfile.findUnique({ where: { storeId: state.targetId } });
      if (
        !profile ||
        profile.entityId !== ctx.entityId ||
        profile.copiedFromStoreId !== (body.copyFromStoreId ?? null) ||
        JSON.stringify(profile.copyOptions) !== JSON.stringify(body.copyOptions ?? []) ||
        profile.addressDetail !== body.addressDetail ||
        profile.industryCode !== body.industryCode ||
        profile.categoryCode !== body.categoryCode
      )
        throw invalid();
    }
  }
  const usage = await getQuotaUsage(tx, { facts: deps.facts }, deps.clock.now(), ctx.entityId!);
  if (
    !Number.isSafeInteger(usage.storesUsed) ||
    usage.storesUsed < 0 ||
    !Number.isSafeInteger(usage.storeLimit) ||
    usage.storeLimit < 0
  )
    throw new AppError("INTERNAL");
  if (usage.storesUsed + (state.inserted ? 0 : 1) > usage.storeLimit)
    throw new AppError("STORE_LIMIT_REACHED", {
      details: {
        storesUsed: usage.storesUsed,
        storeLimit: usage.storeLimit,
        limitReason: usage.limitReason,
      },
    });
  // 最终 await 也不使用锁前时钟；只承诺这个真实认证语句的快照。
  await ports.assertSession(tx, principal, deps.clock.now());
}
export const guardStoreCreate: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (
    !state ||
    !state.inserted ||
    facts.ctx !== state.ctx ||
    facts.machine !== "store" ||
    facts.stateField !== "lifecycle" ||
    facts.subjectId !== state.targetId ||
    facts.entityId !== state.ctx.entityId ||
    facts.storeId !== state.targetId ||
    facts.event !== "store.create"
  )
    return false;
  await current(tx, state);
  return true;
};
export function createStoreCreator(deps: Deps) {
  return async (
    context: IdentityContext,
    raw: StoreCreateBody,
    options: StoreCreateOptions,
  ): Promise<StoreCard> => {
    if (options?.idem?.mode !== "required")
      throw new TypeError("新增门店必须使用 required 幂等上下文");
    const parsed = StoreCreateBodySchema.safeParse(raw);
    if (!parsed.success) throw invalid();
    if (!options.principal) throw new AppError("AUTH_REQUIRED");
    const body = structuredClone(parsed.data),
      principal = structuredClone(options.principal);
    const ctx = createIdentityContext({ ...context, actor: context.actor });
    const ports = deps.storeCreation;
    if (!ports) throw new AppError("INTERNAL");
    // required 缓存不会调用 claim；此门槛必须在进入 runner 前执行。
    await deps.tx.run(async (tx) => {
      await owner(tx, ctx, principal);
      await ports.assertSession(tx, principal, deps.clock.now());
    });
    return createThreePhaseRunner(deps).run<StoreCard, void>(
      {
        claim: async (tx) => {
          await owner(tx, ctx, principal);
          await ports.assertSession(tx, principal, deps.clock.now());
          return undefined;
        },
        external: () => ports.validateBasics(ctx, principal, structuredClone(body)),
        async settle(tx) {
          if (prepared.has(tx)) throw new TypeError("分店创建不能重入");
          const targetId = uuidv7();
          await lockRows(tx, "merchant_user", [principal.merchantUserId]);
          await lockRows(tx, "entity", [ctx.entityId!]);
          const member = await owner(tx, ctx, principal);
          await lockRows(tx, "entity_member", [member.memberId]);
          const stores = [
            ...new Set([
              ctx.storeId!,
              targetId,
              ...(body.copyFromStoreId ? [body.copyFromStoreId] : []),
            ]),
          ].sort();
          await lockRows(tx, "store", stores);
          await lockRows(
            tx,
            "store_profile",
            [targetId, ...(body.copyFromStoreId ? [body.copyFromStoreId] : [])].sort(),
          );
          const state: State = {
            deps,
            ports,
            ctx,
            principal,
            body,
            memberId: member.memberId,
            targetId,
            inserted: false,
            initialized: false,
          };
          await current(tx, state);
          prepared.set(tx, state);
          try {
            const now = deps.clock.now();
            await tx.store.create({
              data: {
                id: targetId,
                entityId: ctx.entityId!,
                name: body.name,
                isPrimary: false,
                lifecycle: "active",
                qualificationStatus: "unsubmitted",
                createdAt: now,
                updatedAt: now,
              },
            });
            state.inserted = true;
            await deps.flow.transition(tx, ctx, {
              machine: "store",
              stateField: "lifecycle",
              id: targetId,
              entityId: ctx.entityId!,
              storeId: targetId,
              event: "store.create",
              created: true,
              emit: {
                type: "store.created",
                payload: { v: 1, storeId: targetId, entityId: ctx.entityId!, isFirstStore: false },
              },
            });
            await ports.initialize(tx, ctx, principal, {
              contextStoreId: ctx.storeId!,
              targetStoreId: targetId,
              copyFromStoreId: body.copyFromStoreId ?? null,
              copyOptions: body.copyOptions ?? [],
              initial: {
                addressDetail: body.addressDetail,
                industryCode: body.industryCode,
                categoryCode: body.categoryCode,
              },
            });
            state.initialized = true;
            const list = await listStores(tx, { facts: deps.facts }, deps.clock.now(), {
              merchantUserId: principal.merchantUserId,
            });
            const card =
              list.viewerRole === "owner"
                ? list.items.find((row) => row.storeId === targetId)
                : undefined;
            if (!card) throw new AppError("INTERNAL");
            await current(tx, state);
            return card;
          } finally {
            prepared.delete(tx);
          }
        },
      },
      options,
    );
  };
}
