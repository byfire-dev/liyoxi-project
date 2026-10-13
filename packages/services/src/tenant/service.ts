// tenant 的装配入口（W1-03）：把时钟、开事务的入口、状态迁移与两个端口绑上，给出主体与门店的全部函数。
// api、worker 启动时各建一次（createFlow 之后）。
//
//   const tenant = createTenant({ tx, clock, flow, assembly });
//   await tenant.createEntity(ctx, { idem });                           // 用例：自己开事务
//   await tx.run((handle) => tenant.resolveMembership(handle, { merchantUserId, storeId }));   // 在调用方的事务里
import type {
  MemberRemovalResult,
  MembershipBrief,
  MembershipResult,
  StoreList,
  StoreArchiveResult,
  StoreDeleteResult,
  StoreCard,
  StoreCreateBody,
  MemberItem,
  MemberList,
  InvitationCreateBody,
  InvitationCard,
  InvitationPreview,
  InvitationMarkSharedResult,
  InvitationRevokeBody,
  InvitationRevokeResult,
  InvitationAcceptBody,
  EntityCard,
  EntityMemberList,
  EntityMemberListQuery,
  EntityQuotaUpdateBody,
  EntityCloseBody,
} from "@liyoxi/contract";
import type { AuditRequestMeta } from "../audit/index.js";

import type { Flow } from "../flow/index.js";
import { AppError, isUniqueViolation, merchantFactsOf } from "../kernel/index.js";
import type {
  Assembly,
  Clock,
  IdempotencyContext,
  IdentityContext,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import {
  createEntityIn,
  existingMembershipResult,
  ONE_ENTITY_CONSTRAINT,
} from "./create-entity.js";
import { resolveMembership } from "./membership.js";
import type { StoreMembership } from "./membership.js";
import { billingAccountPort } from "./ports.js";
import { setDeliveryManager, setStoreName, setStoreQualification } from "./qualification.js";
import type { StoreQualificationInput, StoreQualificationResult } from "./qualification.js";
import { assertWithinQuota, getQuotaUsage } from "./quota.js";
import type { QuotaUsage } from "./quota.js";
import { selectActiveMembership } from "./repo.js";
import type { ActiveMembership, TenantReader } from "./repo.js";
import { listStores, rememberCurrentStore } from "./stores.js";
import { findActiveReferralCode, membershipBriefs } from "./briefs.js";
import type { ReferralHit } from "./briefs.js";
import { removeCallerMemberIn, removeMemberIn } from "./member-removal.js";
import { listMembersIn, updateMemberIn } from "./member-management.js";
import type { MemberManagementDeps } from "./member-management.js";
import { createInvitation, markInvitationSharedIn, revokeInvitationIn } from "./invitations.js";
import type { InvitationDeps, InvitationOptions } from "./invitations.js";
import { invitationPreview } from "./invitation-repo.js";
import { archiveStoreIn, deleteStoreIn } from "./store-archive.js";
import type { StoreDraftFactsReader } from "./store-archive.js";
import { restoreStoreIn } from "./store-restore.js";
import type { Timers } from "../timers/index.js";
import { createInvitationAcceptor } from "./invitation-accept.js";
import { readStoreMembersBrief } from "./profile-members.js";
import type { StoreMembersBrief } from "./profile-members.js";
import { createStoreCreator } from "./store-create.js";
import type { StoreCreation, StoreCreateOptions } from "./store-create.js";
import { adminEntityGetIn, adminEntityMemberListIn } from "./admin-read.js";
import type { TenantAdminReadDeps } from "./admin-read.js";
import type { StaffContext } from "../authz/index.js";
import { updateEntityQuota } from "./admin-quota.js";
import { closeEntity } from "./admin-close.js";
import { closeEntityForOwnerDeletionIn } from "./entity-close.js";
import type { CloseEntityDeps, CloseEntityResult } from "./entity-close.js";
import { abandonDraftIn } from "./empty-draft.js";
import type { DraftAbandonResult } from "./empty-draft.js";
import type { CallerMemberRemoval } from "./member-removal.js";

export interface TenantDeps extends Pick<MemberManagementDeps, "readMemberAssetCounts" | "events"> {
  /** 后台关闭使用完整装配与原 timer；旧用例不要求这组依赖。 */
  readonly entityClose?: Pick<CloseEntityDeps, "assembly" | "timers">;
  /** 仅后台两条主体查询需要，由应用层固定绑定真实事实拥有者。 */
  readonly adminRead?: TenantAdminReadDeps;
  /** 分店创建由上层固定绑定档案与会话拥有者；缺失不影响旧命令。 */
  readonly storeCreation?: StoreCreation;
  /** 删除草稿门店需要六个拥有者的真实同事务历史，缺装配不影响旧用例。 */
  readonly readStoreDraftFacts?: StoreDraftFactsReader;
  /** 仅新门店归档用例需要；同事务取消原邀请到期任务。 */
  readonly archiveTimers?: Pick<Timers, "cancel">;
  /** 仅四个新邀请入口需要；旧用例不因缺此装配失败。 */
  readonly invitations?: InvitationDeps;
  /** 开事务的入口：用例函数用它 */
  readonly tx: TxRunner;
  /** 业务时钟 */
  readonly clock: Clock;
  /** 状态迁移（createFlow 给的）：主体、门店、成员关系的状态只经它改 */
  readonly flow: Flow;
  /** 装配结果：计费账户端口与事实端口的实现从这里取 */
  readonly assembly: Pick<Assembly, "port" | "portEntries">;
}

export interface UseCaseOptions {
  /** 幂等上下文：路由层按路由元数据建好交进来 */
  readonly idem?: IdempotencyContext;
}

export interface Tenant {
  closeEntity(
    ctx: IdentityContext,
    staff: StaffContext,
    input: EntityCloseBody & { readonly entityId: string },
    options: { readonly idem: IdempotencyContext },
  ): Promise<EntityCard>;
  updateEntityQuota(
    ctx: IdentityContext,
    staff: StaffContext,
    input: EntityQuotaUpdateBody & { readonly entityId: string },
    options: { readonly idem: IdempotencyContext; readonly meta: AuditRequestMeta },
  ): Promise<EntityCard>;
  adminEntityGet(staff: StaffContext, entityId: string): Promise<EntityCard>;
  adminEntityMemberList(
    staff: StaffContext,
    entityId: string,
    query: EntityMemberListQuery,
  ): Promise<EntityMemberList>;
  createStore(
    ctx: IdentityContext,
    input: StoreCreateBody,
    options: StoreCreateOptions,
  ): Promise<StoreCard>;
  // ---------- 用例函数：自己开事务 ----------
  /** m.entity.create：懒创建主体、首店、老板成员关系，经端口建计费账户。操作人须是商家用户 */
  createEntity(ctx: IdentityContext, options?: UseCaseOptions): Promise<MembershipResult>;
  /** m.store.list：按账号的有效成员关系现算；老板、店员、没有成员关系三种形状 */
  listStores(viewer: { merchantUserId: string }): Promise<StoreList>;
  archiveStore(
    ctx: IdentityContext,
    input: { storeId: string },
    options?: UseCaseOptions,
  ): Promise<StoreArchiveResult>;
  deleteStore(
    ctx: IdentityContext,
    input: { storeId: string },
    options: UseCaseOptions & { readonly idem: IdempotencyContext },
  ): Promise<StoreDeleteResult>;
  /** 只恢复老板停用的门店，重新占用当前主体额度。 */
  restoreStore(
    ctx: IdentityContext,
    input: { storeId: string },
    options?: UseCaseOptions,
  ): Promise<StoreCard>;
  /** m.me.currentStore.replace：门店进不去即 NOT_FOUND */
  rememberCurrentStore(
    input: { merchantUserId: string; storeId: string },
    options?: UseCaseOptions,
  ): Promise<{ storeId: string }>;
  /** 老板移除当前主体的有效店员。 */
  removeMember(
    ctx: IdentityContext,
    input: { memberId: string },
    options?: UseCaseOptions,
  ): Promise<MemberRemovalResult>;
  /** 店员退出当前主体；老板只能走既有更换或注销流程。 */
  leaveMembership(ctx: IdentityContext, options?: UseCaseOptions): Promise<MemberRemovalResult>;
  /** 当前门店成员；店员仅五字段，老板含真实计数、邀请与主体名额。 */
  listMembers(ctx: IdentityContext): Promise<MemberList>;
  /** 老板全量替换有效店员的门店范围，不迁移成员状态。 */
  updateMember(
    ctx: IdentityContext,
    input: { memberId: string; storeIds: readonly string[] },
    options?: UseCaseOptions,
  ): Promise<MemberItem>;
  createInvitation(
    ctx: IdentityContext,
    input: InvitationCreateBody,
    options?: InvitationOptions,
  ): Promise<InvitationCard>;
  markInvitationShared(
    ctx: IdentityContext,
    input: { invitationId: string },
    options?: UseCaseOptions,
  ): Promise<InvitationMarkSharedResult>;
  revokeInvitation(
    ctx: IdentityContext,
    input: InvitationRevokeBody & { invitationId: string },
    options?: UseCaseOptions,
  ): Promise<InvitationRevokeResult>;
  lookupInvitation(token: string): Promise<InvitationPreview>;
  acceptInvitation(
    ctx: IdentityContext,
    input: InvitationAcceptBody & { invitationId: string },
    options?: InvitationOptions,
  ): Promise<MembershipResult>;

  // ---------- 在调用方的事务里 ----------
  abandonDraftIn(tx: Tx, ctx: IdentityContext): Promise<DraftAbandonResult>;
  removeMemberIn(
    tx: Tx,
    ctx: IdentityContext,
    input: CallerMemberRemoval,
  ): Promise<MemberRemovalResult>;
  revokeInvitationIn(
    tx: Tx,
    ctx: IdentityContext,
    input: InvitationRevokeBody & { readonly invitationId: string },
  ): Promise<InvitationRevokeResult>;
  closeEntityForOwnerDeletionIn(tx: Tx, ctx: IdentityContext): Promise<CloseEntityResult>;
  /** 建档首页真实成员摘要：同 caller Tx 与业务时间，仅有效主体/门店。 */
  readStoreMembersBrief(
    tx: Tx,
    input: { readonly entityId: string; readonly storeId: string; readonly now: Date },
  ): Promise<StoreMembersBrief | null>;
  /** 账号此刻的有效成员关系（V1.0 至多一条）；没有即 null */
  activeMembership(db: TenantReader, merchantUserId: string): Promise<ActiveMembership | null>;
  /** 成员关系解析：进不去即 null；老板进自己停用的门店是收尾上下文 */
  resolveMembership(
    db: TenantReader,
    input: { merchantUserId: string; storeId: string },
  ): Promise<StoreMembership | null>;
  /** 额度与名额的唯一口径：读时现算 */
  getQuotaUsage(tx: Tx, entityId: string): Promise<QuotaUsage>;
  /** 仅门店超额阻断新订购，复用调用方事务和当前额度事实。 */
  assertWithinQuota(tx: Tx, entityId: string): Promise<void>;
  /** 资质 initial 轮次的提交、通过、驳回、撤回：门店与主体两条链同事务 */
  setStoreQualification(
    tx: Tx,
    ctx: IdentityContext,
    input: StoreQualificationInput,
  ): Promise<StoreQualificationResult>;
  /** 首店起名 */
  setStoreName(
    tx: Tx,
    ctx: IdentityContext,
    input: { storeId: string; name: string },
  ): Promise<{ storeId: string; name: string }>;
  /** 改门店的交付经理并写审计 */
  setDeliveryManager(
    tx: Tx,
    ctx: IdentityContext,
    input: {
      storeId: string;
      staffId: string | null;
      auditMeta?: { synced: { dramaOrderCount: number; deliveryTicketCount: number } };
      note?: string;
    },
  ): Promise<{ storeId: string; previousStaffId: string | null; staffId: string | null }>;
  /** 账号的有效成员关系概要（GET /m/me 的 memberships；W1-04）：没有即空数组 */
  membershipBriefs(db: TenantReader, merchantUserId: string): Promise<MembershipBrief[]>;
  /** 首触来源：按码查启用的登记行，邀请码优先；没命中即 null（W1-04） */
  findActiveReferralCode(
    db: Pick<Tx, "referralCode">,
    codes: { inviteCode?: string | undefined; channelCode?: string | undefined },
  ): Promise<ReferralHit | null>;
}

export function createTenant(deps: TenantDeps): Tenant {
  const { flow } = deps;
  const now = (): Date => deps.clock.now();
  const facts = merchantFactsOf(deps.assembly);
  const billingAccount = deps.assembly.port(billingAccountPort);
  const memberDeps = { ...deps, facts };
  const acceptInvitation = createInvitationAcceptor(memberDeps);
  const createStore = createStoreCreator(memberDeps);
  return {
    abandonDraftIn: (tx, ctx) => abandonDraftIn(tx, deps, ctx),
    removeMemberIn: (tx, ctx, input) => removeCallerMemberIn(tx, deps, ctx, input),
    revokeInvitationIn: (tx, ctx, input) => revokeInvitationIn(tx, memberDeps, ctx, input),
    closeEntityForOwnerDeletionIn: (tx, ctx) => {
      if (!deps.entityClose) throw new AppError("INTERNAL");
      return closeEntityForOwnerDeletionIn(
        tx,
        { ...deps.entityClose, flow, clock: deps.clock },
        ctx,
      );
    },
    closeEntity: (ctx, staff, input, options) =>
      closeEntity(memberDeps, ctx, staff, input, options),
    updateEntityQuota: (ctx, staff, input, options) =>
      updateEntityQuota(memberDeps, ctx, staff, input, options),
    adminEntityGet: (staff, entityId) =>
      deps.tx.run((tx) => adminEntityGetIn(tx, deps.adminRead, facts, now(), staff, entityId)),
    adminEntityMemberList: (staff, entityId, query) =>
      deps.tx.run((tx) => adminEntityMemberListIn(tx, deps.adminRead, staff, entityId, query)),
    createStore,
    async createEntity(ctx, options = {}) {
      try {
        return await deps.tx.run(
          (tx) => createEntityIn(tx, { flow, billingAccount }, now(), ctx),
          options,
        );
      } catch (error) {
        // 并发兜底：同一账号的请求本该在账号行锁上排队；万一还是撞了“一个账号只属于一个主体”，
        // 事务已回滚，按“已有成员关系”再看一遍（老板返回已有主体，店员是 ALREADY_IN_ENTITY）
        if (!isUniqueViolation(error, [ONE_ENTITY_CONSTRAINT]) || ctx.actor.id === null) {
          throw error;
        }
        const merchantUserId = ctx.actor.id;
        const existing = await deps.tx.run((tx) => existingMembershipResult(tx, merchantUserId));
        if (existing === null) throw error;
        return existing;
      }
    },
    listStores: (viewer) => deps.tx.run((tx) => listStores(tx, { facts }, now(), viewer)),
    archiveStore: (ctx, input, options = {}) => {
      if (!deps.archiveTimers) throw new AppError("INTERNAL");
      return deps.tx.run(
        (tx) =>
          archiveStoreIn(tx, { ...deps, facts, timers: deps.archiveTimers! }, ctx, input.storeId),
        options,
      );
    },
    restoreStore: (ctx, input, options = {}) =>
      deps.tx.run((tx) => restoreStoreIn(tx, { ...deps, facts }, ctx, input.storeId), options),
    deleteStore: (ctx, input, options) => {
      if (!deps.archiveTimers || !deps.events || !deps.readStoreDraftFacts || !options?.idem)
        throw new AppError("INTERNAL");
      return deps.tx.run(
        (tx) =>
          deleteStoreIn(tx, { ...deps, facts, timers: deps.archiveTimers! }, ctx, input.storeId),
        options,
      );
    },
    rememberCurrentStore: (input, options = {}) =>
      deps.tx.run((tx) => rememberCurrentStore(tx, now(), input), options),
    removeMember: (ctx, input, options = {}) =>
      deps.tx.run((tx) => removeMemberIn(tx, flow, now(), ctx, input.memberId), options),
    leaveMembership: (ctx, options = {}) =>
      deps.tx.run((tx) => removeMemberIn(tx, flow, now(), ctx), options),
    listMembers: (ctx) => deps.tx.run((tx) => listMembersIn(tx, memberDeps, now(), ctx)),
    updateMember: (ctx, input, options = {}) =>
      deps.tx.run((tx) => updateMemberIn(tx, memberDeps, now(), ctx, input), options),
    createInvitation: (ctx, input, options = {}) =>
      createInvitation(memberDeps, ctx, input, options),
    markInvitationShared: (ctx, input, options = {}) =>
      deps.tx.run((tx) => markInvitationSharedIn(tx, memberDeps, ctx, input.invitationId), options),
    revokeInvitation: (ctx, input, options = {}) =>
      deps.tx.run((tx) => revokeInvitationIn(tx, memberDeps, ctx, input), options),
    lookupInvitation: (token) => {
      if (!deps.invitations) throw new AppError("INTERNAL");
      return deps.tx.run((tx) => invitationPreview(tx, facts, now(), token));
    },
    acceptInvitation,
    readStoreMembersBrief,
    activeMembership: (db, merchantUserId) => selectActiveMembership(db, merchantUserId),
    resolveMembership: (db, input) => resolveMembership(db, input),
    getQuotaUsage: (tx, entityId) => getQuotaUsage(tx, { facts }, now(), entityId),
    assertWithinQuota: (tx, entityId) => assertWithinQuota(tx, { facts }, now(), entityId),
    setStoreQualification: (tx, ctx, input) =>
      setStoreQualification(tx, { flow }, now(), ctx, input),
    setStoreName: (tx, ctx, input) => setStoreName(tx, now(), ctx, input),
    setDeliveryManager: (tx, ctx, input) => setDeliveryManager(tx, now(), ctx, input),
    membershipBriefs: (db, merchantUserId) => membershipBriefs(db, now(), merchantUserId),
    findActiveReferralCode: (db, codes) => findActiveReferralCode(db, codes),
  };
}
