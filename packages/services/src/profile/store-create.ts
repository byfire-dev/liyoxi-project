import { IdSchema } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { z } from "zod";
import { assertCurrentSession } from "../identity/index.js";
import type { SessionPrincipal } from "../identity/index.js";
import { AppError, actorColumns, lockRows, uuidv7 } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import { createStoreAssetCopyOwner } from "../media/index.js";
import type {
  StoreAssetCopyOwner,
  StoreAssetCopyPlan,
  StoreAssetCopyDeps,
} from "../media/index.js";
import { readStoreAssetFacts } from "../tenant/index.js";
import type { Tenant } from "../tenant/index.js";
import { refreshCompleteness } from "./repo.js";
import { invalid, validateBasics } from "./validate.js";

export type StoreProfileCopyOption = "basic" | "service" | "media";
export interface StoreProfileInitInput {
  readonly contextStoreId: string;
  readonly targetStoreId: string;
  readonly copyFromStoreId: string | null;
  readonly copyOptions: readonly StoreProfileCopyOption[];
  readonly initial: {
    readonly addressDetail: string;
    readonly industryCode: string;
    readonly categoryCode: string;
  };
}
/** 只有文件集合可用于下游共同预锁；授权和来源快照不由调用者携带。 */
export interface StoreProfileInitPlan {
  readonly fileIds: readonly string[];
}
export interface StoreProfileInitializerDeps {
  readonly clock: Clock;
  readonly tenant: Pick<Tenant, "resolveMembership">;
  readonly media: Pick<Media, "link">;
  readonly expectedAppid: string;
}
export interface StoreProfileAssetInitInput extends Omit<StoreProfileInitInput, "copyOptions"> {
  readonly copyOptions: readonly (StoreProfileCopyOption | "brand_assets")[];
}
export interface StoreProfileAssetInitializerDeps extends StoreProfileInitializerDeps {
  readonly sla: StoreAssetCopyDeps["sla"];
  readonly timers: StoreAssetCopyDeps["timers"];
}
const Input = z.strictObject({
  contextStoreId: IdSchema,
  targetStoreId: IdSchema,
  copyFromStoreId: IdSchema.nullable(),
  copyOptions: z.array(z.enum(["basic", "service", "media"])).max(3),
  initial: z.strictObject({
    addressDetail: z.string().min(1).max(200),
    industryCode: z.string().min(1).max(64),
    categoryCode: z.string().min(1).max(64),
  }),
});
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const AssetInput = Input.extend({
  copyOptions: z.array(z.enum(["basic", "service", "media", "brand_assets"])).max(4),
});
async function readSource(tx: Tx, input: StoreProfileAssetInitInput) {
  const storeId = input.copyFromStoreId;
  const profile = storeId ? await tx.storeProfile.findUnique({ where: { storeId } }) : null;
  const services =
    storeId && input.copyOptions.includes("service")
      ? await tx.storeServiceItem.findMany({
          where: { storeId, removedAt: null },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        })
      : [];
  const media =
    storeId && input.copyOptions.includes("media")
      ? await tx.storeProfileMedia.findMany({
          where: { storeId, removedAt: null },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        })
      : [];
  return { profile, services, media };
}

/** 调用方在完整低序图阶段 prepare；未来素材370完成后共同锁410，再 apply。 */
function createInitializer(deps: StoreProfileInitializerDeps, assets?: StoreAssetCopyOwner) {
  const { clock, tenant, media, expectedAppid } = deps;
  if (!expectedAppid) throw new TypeError("档案初始化必须绑定真实 AppID");
  type State = {
    tx: Tx;
    ctx: IdentityContext;
    principal: SessionPrincipal;
    input: StoreProfileAssetInitInput;
    entityId: string;
    source: Awaited<ReturnType<typeof readSource>>;
    consumed: boolean;
    assets?: StoreAssetCopyPlan;
    inserted?: boolean;
  };
  const plans = new WeakMap<StoreProfileInitPlan, State>();
  async function current(tx: Tx, state: Omit<State, "source" | "consumed" | "tx">) {
    const { ctx, principal, input, entityId } = state;
    const member = await tenant.resolveMembership(tx, {
      merchantUserId: principal.merchantUserId,
      storeId: input.contextStoreId,
    });
    if (!member || member.entityId !== entityId) throw new AppError("NOT_A_MEMBER");
    if (member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
    if (member.storeMode !== "active") throw new AppError("STORE_ARCHIVED");
    if (ctx.entityId !== entityId || ctx.storeId !== input.contextStoreId)
      throw invalid("档案初始化上下文不属于当前门店");
    const target = await tx.store.findUnique({ where: { id: input.targetStoreId } });
    const profile = await tx.storeProfile.findUnique({ where: { storeId: input.targetStoreId } });
    if (
      !target ||
      target.entityId !== entityId ||
      target.lifecycle !== "active" ||
      target.isPrimary ||
      target.qualificationStatus !== "unsubmitted" ||
      (state.inserted
        ? !profile ||
          profile.entityId !== entityId ||
          profile.copiedFromStoreId !== input.copyFromStoreId ||
          JSON.stringify(profile.copyOptions) !== JSON.stringify(input.copyOptions)
        : profile)
    )
      throw invalid("目标必须是同主体尚无档案的启用分店");
    if (input.copyFromStoreId) {
      const source = await tx.store.findUnique({ where: { id: input.copyFromStoreId } });
      if (
        !source ||
        source.entityId !== entityId ||
        (source.lifecycle !== "active" &&
          !(source.lifecycle === "archived" && source.archiveReason === "by_owner"))
      )
        throw invalid("复制来源不是本主体可用门店");
    }
    // 取时钟在所有业务锁等待和事实读取之后；只承诺本语句的真实会话快照。
    await assertCurrentSession(tx, principal, clock.now(), expectedAppid);
  }
  async function prepare(
    tx: Tx,
    ctx: IdentityContext,
    principal: SessionPrincipal,
    raw: StoreProfileAssetInitInput,
  ): Promise<StoreProfileInitPlan> {
    const parsed = (assets ? AssetInput : Input).safeParse(raw);
    if (!parsed.success) throw invalid("档案初始化输入不合法");
    const input: StoreProfileAssetInitInput = parsed.data;
    if (
      new Set(input.copyOptions).size !== input.copyOptions.length ||
      (!input.copyFromStoreId && input.copyOptions.length > 0) ||
      input.targetStoreId === input.contextStoreId ||
      input.targetStoreId === input.copyFromStoreId
    )
      throw invalid("复制选择重复、缺少来源或目标与来源相同");
    ctx = structuredClone(ctx);
    principal = structuredClone(principal);
    if (ctx.actor.type !== "merchant" || ctx.actor.id !== principal.merchantUserId)
      throw new AppError("ROLE_FORBIDDEN");
    await lockRows(tx, "merchant_user", [principal.merchantUserId]);
    const context = await tx.store.findUnique({ where: { id: input.contextStoreId } });
    if (!context) throw new AppError("NOT_A_MEMBER");
    const entityId = context.entityId;
    await lockRows(tx, "entity", [entityId]);
    const member = await tx.entityMember.findFirst({
      where: { entityId, merchantUserId: principal.merchantUserId, status: "active" },
    });
    if (!member) throw new AppError("NOT_A_MEMBER");
    await lockRows(tx, "entity_member", [member.id]);
    await lockRows(tx, "store", [
      input.contextStoreId,
      input.targetStoreId,
      ...(input.copyFromStoreId ? [input.copyFromStoreId] : []),
    ]);
    // 缺行135不假称有物理行锁；130排斥旧 profile writer，apply还会核缺失。
    await lockRows(tx, "store_profile", [
      input.targetStoreId,
      ...(input.copyFromStoreId ? [input.copyFromStoreId] : []),
    ]);
    const state = {
      tx,
      ctx: structuredClone(ctx),
      principal: structuredClone(principal),
      input,
      entityId,
    };
    await current(tx, state);
    const source = await readSource(tx, input);
    if (
      input.copyOptions.includes("basic") &&
      source.profile &&
      !Array.isArray(source.profile.businessHours)
    )
      throw invalid("来源营业时间不是合法数组");
    const assetPlan =
      assets && input.copyOptions.includes("brand_assets")
        ? await assets.prepare(tx, {
            entityId,
            sourceStoreId: input.copyFromStoreId!,
            targetStoreId: input.targetStoreId,
          })
        : undefined;
    const fileIds = sorted([
      ...(input.copyOptions.includes("basic") && source.profile?.logoFileId
        ? [source.profile.logoFileId]
        : []),
      ...source.services.flatMap((row) => (row.imageFileId ? [row.imageFileId] : [])),
      ...source.media.map((row) => row.fileId),
      ...(assetPlan?.fileIds ?? []),
    ]);
    const plan = Object.freeze({ fileIds: Object.freeze(fileIds) });
    plans.set(plan, { ...state, source, assets: assetPlan, consumed: false });
    return plan;
  }
  async function apply(tx: Tx, plan: StoreProfileInitPlan): Promise<void> {
    const state = plans.get(plan);
    if (!state || state.tx !== tx || state.consumed)
      throw new TypeError("档案计划必须来自本实例、本事务且尚未消费");
    state.consumed = true;
    const { input, entityId, source, ctx } = state;
    await lockRows(tx, "file_object", plan.fileIds);
    await validateBasics(tx, input.initial, null, true);
    await current(tx, state);
    const now = clock.now(),
      storeId = input.targetStoreId;
    const p = source.profile;
    const basic = input.copyOptions.includes("basic") && p;
    const service = input.copyOptions.includes("service") && p;
    await tx.storeProfile.create({
      data: {
        storeId,
        entityId,
        ...input.initial,
        copiedFromStoreId: input.copyFromStoreId,
        copyOptions: [...input.copyOptions],
        ...(basic
          ? {
              brandName: basic.brandName,
              brandIntro: basic.brandIntro,
              businessHours: basic.businessHours as Prisma.InputJsonValue,
              logoFileId: basic.logoFileId,
            }
          : {}),
        ...(service
          ? {
              promoText: service.promoText,
              groupBuyText: service.groupBuyText,
              sellingPointCodes: [...service.sellingPointCodes],
              sellingNote: service.sellingNote,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
    });
    state.inserted = true;
    const link = (fileId: string, refType: string, refId: string, role: string) =>
      media.link(tx, { fileId, refType, refId, role, entityId, storeId });
    if (basic && basic.logoFileId) await link(basic.logoFileId, "store_profile", storeId, "logo");
    for (const row of source.services) {
      const id = uuidv7();
      await tx.storeServiceItem.create({
        data: {
          id,
          storeId,
          entityId,
          name: row.name,
          position: row.position,
          priceFen: row.priceFen,
          originalPriceFen: row.originalPriceFen,
          imageFileId: row.imageFileId,
          intro: row.intro,
          createdAt: now,
          updatedAt: now,
        },
      });
      if (row.imageFileId) await link(row.imageFileId, "store_service_item", id, "image");
    }
    const actor = actorColumns(ctx.actor);
    for (const row of source.media) {
      const id = uuidv7();
      await tx.storeProfileMedia.create({
        data: {
          id,
          storeId,
          entityId,
          mediaGroup: row.mediaGroup,
          mediaKind: row.mediaKind,
          fileId: row.fileId,
          caption: row.caption,
          position: row.position,
          copiedFromStoreId: input.copyFromStoreId,
          createActorType: actor.actorType,
          createActorId: actor.actorId,
          createClient: actor.client,
          createdAt: now,
          updatedAt: now,
        },
      });
      await link(row.fileId, "store_profile_media", id, "main");
    }
    await refreshCompleteness(tx, storeId, now);
    if (state.assets) await assets!.apply(tx, state.assets);
    // 最后一个引用、时限与完整度 await 之后重新读取当前授权和真实会话。
    if (assets) await current(tx, state);
  }
  return { prepare, apply };
}
export function createStoreProfileInitializer(deps: StoreProfileInitializerDeps) {
  const impl = createInitializer(deps);
  return {
    ...impl,
    prepare: (
      tx: Tx,
      ctx: IdentityContext,
      principal: SessionPrincipal,
      input: StoreProfileInitInput,
    ) => impl.prepare(tx, ctx, principal, input),
  };
}
/** 四项组合固定绑定 tenant 真实公口；调用者不能替换来源事实或授权 owner。 */
export function createStoreProfileAssetInitializer(deps: StoreProfileAssetInitializerDeps) {
  return createInitializer(
    deps,
    createStoreAssetCopyOwner({
      clock: deps.clock,
      media: deps.media,
      sla: deps.sla,
      timers: deps.timers,
      readStore: readStoreAssetFacts,
    }),
  );
}
export type StoreProfileInitializer = ReturnType<typeof createStoreProfileInitializer>;
export type StoreProfileAssetInitializer = ReturnType<typeof createStoreProfileAssetInitializer>;
