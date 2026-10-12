import { EntityCardSchema, EntityMemberListSchema, EntityStoreRowSchema } from "@liyoxi/contract";
import type {
  EntityCard,
  EntityMemberList,
  EntityMemberListQuery,
  EntityStoreRow,
} from "@liyoxi/contract";
import { entityScope, hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { MerchantFactsReader, Tx } from "../kernel/index.js";
import { quotaWithSubscription } from "./quota.js";

/** 上层绑定各事实拥有者；tenant 不同步引用同层业务域。 */
export interface TenantAdminReadDeps {
  readonly billing: (
    tx: Tx,
    input: { entityId: string; now: Date },
  ) => Promise<{
    subscription: EntityCard["subscription"];
    spendablePoints: number;
  }>;
  readonly profiles: (
    tx: Tx,
    input: { entityId: string; storeIds: readonly string[] },
  ) => Promise<
    ReadonlyMap<
      string,
      Pick<
        EntityStoreRow,
        | "lastDecidedAt"
        | "reviewDueAt"
        | "openQualificationSubmissionId"
        | "address"
        | "copiedFromStoreId"
      >
    >
  >;
  readonly assets: (
    tx: Tx,
    input: { entityId: string; storeIds: readonly string[]; merchantUserIds: readonly string[] },
  ) => Promise<{
    stores: ReadonlyMap<
      string,
      Pick<EntityStoreRow, "assetCount" | "reviewedAssetCount" | "copiedAssetCount">
    >;
    members: ReadonlyMap<string, { uploadedAssetCount: number; adoptedAssetCount: number }>;
  }>;
  readonly orders: (tx: Tx, storeId: string) => Promise<{ live: number; to_launch: number }>;
}

const userSelect = {
  id: true,
  displayName: true,
  phoneMask: true,
  status: true,
  createdAt: true,
} as const;
function members(tx: Tx, entityId: string, query: Partial<EntityMemberListQuery> = {}) {
  return tx.entityMember.findMany({
    where: {
      entityId,
      ...(!query.includeRemoved ? { status: "active" } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.storeId
        ? { OR: [{ role: "owner" }, { storeMemberships: { some: { storeId: query.storeId } } }] }
        : {}),
    },
    select: {
      id: true,
      role: true,
      status: true,
      displayName: true,
      merchantUserId: true,
      createdAt: true,
      removedAt: true,
      removeReason: true,
      merchantUser: { select: userSelect },
      storeMemberships: { select: { storeId: true }, orderBy: { storeId: "asc" } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
type Member = Awaited<ReturnType<typeof members>>[number];
const userBrief = (row: Member) => ({
  merchantUserId: row.merchantUserId,
  displayName: row.displayName ?? row.merchantUser.displayName,
  phoneMask: row.merchantUser.phoneMask,
  status: row.merchantUser.status,
});
async function visibleEntity(tx: Tx, staff: StaffContext, entityId: string) {
  const row = await tx.entity.findFirst({
    where: { AND: [{ id: entityId }, entityScope(staff.scope)] },
    select: {
      id: true,
      name: true,
      entityType: true,
      lifecycle: true,
      closedAt: true,
      verificationStatus: true,
      usccMask: true,
      legalRepNameMask: true,
      verifiedAt: true,
      sourceType: true,
      createdAt: true,
      lockVersion: true,
      storeLimitOverride: true,
      memberLimitOverride: true,
      sourceReferralCode: { select: { id: true, code: true, label: true } },
    },
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
function binding(deps: TenantAdminReadDeps | undefined) {
  if (
    !deps ||
    ![deps.billing, deps.profiles, deps.assets, deps.orders].every((f) => typeof f === "function")
  )
    throw new AppError("INTERNAL");
  return deps;
}
function required<K, V>(map: ReadonlyMap<K, V>, id: K): V {
  const value = map.get(id);
  if (value === undefined) throw new AppError("INTERNAL");
  return value;
}

/** 同 caller Tx 的正式主体摘要；门店概要按合同包含不可单独打开详情的兄弟门店。 */
export async function adminEntityGetIn(
  tx: Tx,
  deps: TenantAdminReadDeps | undefined,
  facts: MerchantFactsReader,
  at: Date,
  staff: StaffContext,
  entityId: string,
): Promise<EntityCard> {
  const entity = await visibleEntity(tx, staff, entityId);
  const readers = binding(deps);
  if (!facts.has("billing")) throw new AppError("INTERNAL");
  const [{ usage }, billing, stores, activeMembers, invitations] = await Promise.all([
    quotaWithSubscription(tx, { facts }, at, entityId),
    readers.billing(tx, { entityId, now: at }),
    tx.store.findMany({
      where: { entityId },
      select: {
        id: true,
        name: true,
        isPrimary: true,
        lifecycle: true,
        qualificationStatus: true,
        createdAt: true,
        deliveryManager: {
          select: {
            id: true,
            staffNo: true,
            name: true,
            staffRoleKey: true,
            isLead: true,
            status: true,
          },
        },
        _count: {
          select: {
            storeMembers: { where: { entityMember: { status: "active", role: "clerk" } } },
          },
        },
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
    members(tx, entityId),
    tx.invitation.findMany({
      where: { entityId, status: "pending", expiresAt: { gt: at } },
      select: {
        id: true,
        storeId: true,
        remarkName: true,
        createdAt: true,
        expiresAt: true,
        inviterMember: { select: { displayName: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  const storeIds = stores.map((s) => s.id);
  const [profiles, assets] = await Promise.all([
    readers.profiles(tx, { entityId, storeIds }),
    readers.assets(tx, { entityId, storeIds, merchantUserIds: [] }),
  ]);
  const storeRows: EntityStoreRow[] = [];
  for (const s of stores) {
    const manager = s.deliveryManager;
    // 原拥有者公口只支持单店计数；逐店调用，不伪称批量订单事实。
    const orders = await readers.orders(tx, s.id);
    const row = EntityStoreRowSchema.safeParse({
      storeId: s.id,
      name: s.name,
      isPrimary: s.isPrimary,
      lifecycle: s.lifecycle,
      qualificationStatus: s.qualificationStatus,
      createdAt: s.createdAt.toISOString(),
      ...required(profiles, s.id),
      ...required(assets.stores, s.id),
      deliveryManager: manager
        ? {
            staffId: manager.id,
            staffNo: manager.staffNo,
            name: manager.name,
            roleKey: manager.staffRoleKey,
            isLead: manager.isLead,
            status: manager.status,
          }
        : null,
      liveDramaCount: orders.live,
      producingDramaCount: orders.to_launch,
      clerkCount: s._count.storeMembers,
    });
    if (!row.success) throw new AppError("INTERNAL");
    storeRows.push(row.data);
  }
  const owner = activeMembers.find((m) => m.role === "owner");
  const referral = entity.sourceReferralCode;
  const result = EntityCardSchema.safeParse({
    entityId: entity.id,
    name: entity.name,
    entityType: entity.entityType,
    lifecycle: entity.lifecycle,
    closedAt: entity.closedAt?.toISOString() ?? null,
    verificationStatus: entity.verificationStatus,
    usccMask: entity.usccMask,
    legalRepNameMask: entity.legalRepNameMask,
    verifiedAt: entity.verifiedAt?.toISOString() ?? null,
    sourceType: entity.sourceType,
    referralCode: referral
      ? { referralCodeId: referral.id, code: referral.code, label: referral.label }
      : null,
    createdAt: entity.createdAt.toISOString(),
    owner: entity.lifecycle === "active" && owner ? userBrief(owner) : null,
    subscription: billing.subscription,
    spendablePoints: billing.spendablePoints,
    usage: {
      ...usage,
      storeLimitOverride: entity.storeLimitOverride,
      memberLimitOverride: entity.memberLimitOverride,
      activeMemberCount: activeMembers.length,
      isOverLimit: usage.storesOver > 0 || usage.seatsOver > 0,
    },
    stores: storeRows,
    pendingInvitations: invitations.map((i) => ({
      invitationId: i.id,
      storeId: i.storeId,
      remarkName: i.remarkName,
      inviterName: i.inviterMember.displayName,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
    })),
    lockVersion: entity.lockVersion,
    actions:
      entity.lifecycle === "active"
        ? [
            ...(hasPermission(staff, "merchant.quota.override") ? ["update-quota"] : []),
            ...(hasPermission(staff, "merchant.entity.close") ? ["close"] : []),
          ]
        : [],
  });
  if (!result.success) throw new AppError("INTERNAL");
  return result.data;
}

export async function adminEntityMemberListIn(
  tx: Tx,
  deps: TenantAdminReadDeps | undefined,
  staff: StaffContext,
  entityId: string,
  query: EntityMemberListQuery,
): Promise<EntityMemberList> {
  await visibleEntity(tx, staff, entityId);
  const readers = binding(deps);
  if (
    query.storeId &&
    !(await tx.store.findFirst({ where: { id: query.storeId, entityId }, select: { id: true } }))
  )
    throw new AppError("NOT_FOUND");
  const rows = await members(tx, entityId, query);
  rows.sort((a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1));
  const stores = await tx.store.findMany({ where: { entityId }, select: { id: true } });
  const assets = await readers.assets(tx, {
    entityId,
    storeIds: stores.map((s) => s.id),
    merchantUserIds: [...new Set(rows.map((r) => r.merchantUserId))],
  });
  for (const store of stores) required(assets.stores, store.id);
  const result = EntityMemberListSchema.safeParse({
    items: rows.map((row) => ({
      memberId: row.id,
      user: userBrief(row),
      role: row.role,
      status: row.status,
      storeIds: row.role === "owner" ? [] : row.storeMemberships.map((s) => s.storeId),
      joinedAt: row.createdAt.toISOString(),
      registeredAt: row.merchantUser.createdAt.toISOString(),
      removedAt: row.removedAt?.toISOString() ?? null,
      removeReason: row.removeReason,
      ...required(assets.members, row.merchantUserId),
      actions:
        row.merchantUser.status === "deleted"
          ? []
          : [
              ...(hasPermission(staff, "merchant.user.disable")
                ? [row.merchantUser.status === "active" ? "disable" : "enable"]
                : []),
              ...(hasPermission(staff, "merchant.user.force_logout") ? ["force-logout"] : []),
            ],
    })),
  });
  if (!result.success) throw new AppError("INTERNAL");
  return result.data;
}
