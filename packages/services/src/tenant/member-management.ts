// W2-10：当前门店成员与老板调整门店范围，共用完整成员映射。
import { MemberUpdateBodySchema } from "@liyoxi/contract";
import type { MemberItem, MemberItemForClerk, MemberList } from "@liyoxi/contract";
import { record as recordAudit } from "../audit/index.js";
import type { Events } from "../events/index.js";
import { AppError, isUuid, lockRows } from "../kernel/index.js";
import type { IdentityContext, MerchantFactsReader, Tx } from "../kernel/index.js";
import { resolveMembership } from "./membership.js";
import { quotaWithSubscription } from "./quota.js";

export interface MemberManagementDeps {
  readonly facts: MerchantFactsReader;
  readonly events?: Pick<Events, "emit">;
  // 由应用组合根注入实际拥有者；tenant 不同步依赖同层 media。
  readonly readMemberAssetCounts?: (
    tx: Tx,
    input: { entityId: string; storeId: string; merchantUserIds: readonly string[] },
  ) => Promise<ReadonlyMap<string, { uploadCount: number; adoptedCount: number }>>;
}

async function memberContext(tx: Tx, ctx: IdentityContext, ownerOnly = false) {
  if (ctx.actor.type !== "merchant" || ctx.actor.client !== "weapp" || !ctx.storeId)
    throw new AppError("NOT_A_MEMBER");
  const member = await resolveMembership(tx, {
    merchantUserId: ctx.actor.id,
    storeId: ctx.storeId,
  });
  if (!member || member.entityId !== ctx.entityId) throw new AppError("NOT_A_MEMBER");
  const user = await tx.merchantUser.findUnique({
    where: { id: ctx.actor.id },
    select: { status: true },
  });
  if (user?.status !== "active") throw new AppError("NOT_A_MEMBER");
  if (ownerOnly && member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  if (member.storeMode !== "active") throw new AppError("STORE_ARCHIVED");
  return { ...member, merchantUserId: ctx.actor.id };
}

function memberRows(tx: Tx, entityId: string, filter: { storeId?: string; memberId?: string }) {
  return tx.entityMember.findMany({
    where: {
      entityId,
      status: "active",
      ...(filter.memberId ? { id: filter.memberId } : {}),
      ...(filter.storeId
        ? { OR: [{ role: "owner" }, { storeMemberships: { some: { storeId: filter.storeId } } }] }
        : {}),
    },
    select: {
      id: true,
      role: true,
      merchantUserId: true,
      displayName: true,
      createdAt: true,
      merchantUser: { select: { displayName: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
type MemberRow = Awaited<ReturnType<typeof memberRows>>[number];
const brief = (row: MemberRow, userId: string): MemberItemForClerk => ({
  memberId: row.id,
  role: row.role as MemberItemForClerk["role"],
  displayName: row.displayName ?? row.merchantUser.displayName,
  joinedAt: row.createdAt.toISOString(),
  isSelf: row.merchantUserId === userId,
});

async function fullItems(
  tx: Tx,
  deps: MemberManagementDeps,
  viewer: { entityId: string; storeId: string; merchantUserId: string },
  rows: readonly MemberRow[],
): Promise<MemberItem[]> {
  if (!deps.readMemberAssetCounts) throw new AppError("INTERNAL");
  const userIds = [...new Set(rows.map((row) => row.merchantUserId))];
  const [counts, phones, scopes] = await Promise.all([
    deps.readMemberAssetCounts(tx, {
      entityId: viewer.entityId,
      storeId: viewer.storeId,
      merchantUserIds: userIds,
    }),
    tx.merchantUser.findMany({
      where: { id: { in: userIds } },
      select: { id: true, phoneMask: true },
    }),
    tx.storeMember.findMany({
      where: { entityId: viewer.entityId, entityMemberId: { in: rows.map((row) => row.id) } },
      select: {
        entityMemberId: true,
        store: { select: { id: true, name: true, lifecycle: true, qualificationStatus: true } },
      },
      orderBy: [{ store: { createdAt: "asc" } }, { storeId: "asc" }],
    }),
  ]);
  const phoneById = new Map(phones.map((row) => [row.id, row.phoneMask]));
  return rows.map((row) => {
    const count = counts.get(row.merchantUserId);
    if (
      !count ||
      !Number.isSafeInteger(count.uploadCount) ||
      !Number.isSafeInteger(count.adoptedCount) ||
      count.uploadCount < 0 ||
      count.adoptedCount < 0 ||
      count.adoptedCount > count.uploadCount ||
      !phoneById.has(row.merchantUserId)
    )
      throw new AppError("INTERNAL");
    return {
      ...brief(row, viewer.merchantUserId),
      phoneMask: phoneById.get(row.merchantUserId) ?? null,
      storeScope: row.role === "owner" ? "all" : "listed",
      stores:
        row.role === "owner"
          ? []
          : scopes
              .filter((scope) => scope.entityMemberId === row.id)
              .map(({ store }) => ({
                storeId: store.id,
                name: store.name,
                lifecycle: store.lifecycle as MemberItem["stores"][number]["lifecycle"],
                qualificationStatus:
                  store.qualificationStatus as MemberItem["stores"][number]["qualificationStatus"],
              })),
      uploadCount: count.uploadCount,
      adoptedCount: count.adoptedCount,
      actions: row.role === "owner" ? [] : ["update", "remove"],
    };
  });
}

export async function listMembersIn(
  tx: Tx,
  deps: MemberManagementDeps,
  now: Date,
  ctx: IdentityContext,
): Promise<MemberList> {
  const viewer = await memberContext(tx, ctx);
  const rows = await memberRows(tx, viewer.entityId, { storeId: viewer.storeId });
  rows.sort((a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1));
  if (viewer.role === "clerk")
    return { viewerRole: "clerk", items: rows.map((row) => brief(row, viewer.merchantUserId)) };
  const [items, invitations, { usage, subscription }] = await Promise.all([
    fullItems(tx, deps, viewer, rows),
    tx.invitation.findMany({
      where: {
        entityId: viewer.entityId,
        storeId: viewer.storeId,
        status: "pending",
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        remarkName: true,
        targetPhoneBidx: true,
        sharedAt: true,
        inviterMemberId: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    quotaWithSubscription(tx, deps, now, viewer.entityId),
  ]);
  return {
    viewerRole: "owner",
    items,
    pendingInvitations: invitations.map((row) => ({
      invitationId: row.id,
      role: "clerk",
      remarkName: row.remarkName,
      isPhoneRestricted: row.targetPhoneBidx !== null,
      isShared: row.sharedAt !== null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      actions: ["revoke"],
    })),
    seats: {
      seatsUsed: usage.seatsUsed,
      memberLimit: usage.memberLimit,
      pendingInvitationCount: usage.pendingInvitationCount,
      includesUnsharedDraft: invitations.some(
        (row) => row.inviterMemberId === viewer.memberId && row.sharedAt === null,
      ),
      seatsOver: usage.seatsOver,
      limitReason: usage.limitReason,
      planName: subscription?.planName ?? null,
    },
  };
}

const invalidStores = (): never => {
  throw new AppError("VALIDATION_FAILED", {
    details: { fieldErrors: [{ path: "storeIds", message: "请选择本主体启用中的门店" }] },
  });
};

export async function updateMemberIn(
  tx: Tx,
  deps: MemberManagementDeps,
  now: Date,
  ctx: IdentityContext,
  input: { memberId: string; storeIds: readonly string[] },
): Promise<MemberItem> {
  const parsed = MemberUpdateBodySchema.safeParse({ storeIds: input.storeIds });
  if (!parsed.success)
    throw new AppError("VALIDATION_FAILED", {
      details: {
        fieldErrors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  if (!ctx.entityId || !isUuid(ctx.entityId)) throw new AppError("NOT_A_MEMBER");
  if (!isUuid(input.memberId)) throw new AppError("NOT_FOUND");
  await lockRows(tx, "entity", [ctx.entityId]);
  const initial = await memberContext(tx, ctx, true);
  const candidate = await tx.entityMember.findUnique({
    where: { id: input.memberId },
    select: { entityId: true },
  });
  if (!candidate || candidate.entityId !== initial.entityId) throw new AppError("NOT_FOUND");
  await lockRows(tx, "entity_member", [...new Set([initial.memberId, input.memberId])].sort());
  const before = await tx.storeMember.findMany({
    where: { entityId: initial.entityId, entityMemberId: input.memberId },
    select: { storeId: true },
    orderBy: { storeId: "asc" },
  });
  const storeIds = [...parsed.data.storeIds].sort();
  const requested = await tx.store.findMany({
    where: { id: { in: storeIds }, entityId: initial.entityId },
    select: { id: true },
  });
  if (requested.length !== storeIds.length) invalidStores();
  await lockRows(
    tx,
    "store",
    [...new Set([initial.storeId, ...storeIds, ...before.map((row) => row.storeId)])].sort(),
  );
  const viewer = await memberContext(tx, ctx, true);
  if (viewer.memberId !== initial.memberId) throw new AppError("NOT_A_MEMBER");
  const target = await tx.entityMember.findUnique({ where: { id: input.memberId } });
  if (!target || target.entityId !== viewer.entityId) throw new AppError("NOT_FOUND");
  if (target.role !== "clerk" || target.status !== "active")
    throw new AppError("STATE_NOT_ALLOWED");
  const valid = await tx.store.count({
    where: { id: { in: storeIds }, entityId: viewer.entityId, lifecycle: "active" },
  });
  if (valid !== storeIds.length) invalidStores();
  const current = await tx.storeMember.findMany({
    where: { entityMemberId: target.id, entityId: viewer.entityId },
    select: { storeId: true },
    orderBy: { storeId: "asc" },
  });
  const beforeIds = before.map((row) => row.storeId);
  if (current.map((row) => row.storeId).join() !== beforeIds.join())
    throw new AppError("STATE_NOT_ALLOWED");
  if (!deps.events || !deps.readMemberAssetCounts) throw new AppError("INTERNAL");
  const addedStoreIds = storeIds.filter((id) => !beforeIds.includes(id));
  const removedStoreIds = beforeIds.filter((id) => !storeIds.includes(id));
  const clearLastStore = target.lastStoreId !== null && !storeIds.includes(target.lastStoreId);
  if (!addedStoreIds.length && !removedStoreIds.length && clearLastStore)
    await tx.entityMember.update({
      where: { id: target.id },
      data: { lastStoreId: null, updatedAt: now },
    });
  if (addedStoreIds.length || removedStoreIds.length) {
    if (removedStoreIds.length)
      await tx.storeMember.deleteMany({
        where: {
          entityMemberId: target.id,
          entityId: viewer.entityId,
          storeId: { in: removedStoreIds },
        },
      });
    if (addedStoreIds.length)
      await tx.storeMember.createMany({
        data: addedStoreIds.map((storeId) => ({
          entityMemberId: target.id,
          entityId: viewer.entityId,
          storeId,
          addedByMemberId: viewer.memberId,
          createdAt: now,
        })),
      });
    await tx.entityMember.update({
      where: { id: target.id },
      data: {
        ...(clearLastStore ? { lastStoreId: null } : {}),
        updatedAt: now,
      },
    });
    await recordAudit(
      tx,
      ctx.actor,
      {
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: "activity",
        category: "member",
        action: "tenant.member.update_stores",
        summary: "调整店员所属门店",
        target: { type: "entity_member", id: target.id, label: target.displayName },
        entityId: viewer.entityId,
        storeId: viewer.storeId,
        before: { storeIds: beforeIds },
        after: { storeIds },
        fields: ["storeIds"],
      },
    );
    await deps.events.emit(tx, ctx, {
      type: "entity_member.stores_changed",
      aggregate: { type: "entity_member", id: target.id },
      payload: {
        v: 1,
        entityMemberId: target.id,
        entityId: viewer.entityId,
        merchantUserId: target.merchantUserId,
        addedStoreIds,
        removedStoreIds,
        invitationId: null,
      },
    });
  }
  const [result] = await fullItems(
    tx,
    deps,
    viewer,
    await memberRows(tx, viewer.entityId, { memberId: target.id }),
  );
  if (!result) throw new AppError("INTERNAL");
  return result;
}
