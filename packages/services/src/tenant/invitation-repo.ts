// 邀请拥有者的只读视图、敏感字段与完整业务锁图。
import { createHash, randomBytes } from "node:crypto";
import type { InvitationCard, InvitationPreview } from "@liyoxi/contract";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, MerchantFactsReader, Tx } from "../kernel/index.js";
import { decryptField, encryptField, phoneBidx } from "../security/index.js";
import type { Keyring } from "../security/index.js";
import { resolveMembership } from "./membership.js";
import { quotaWithSubscription } from "./quota.js";

export const invitationHash = (token: string) => createHash("sha256").update(token).digest();
export const invitationFields = (keyring: Keyring, phone?: string | null) => ({
  targetPhoneBidx: phone ? phoneBidx(keyring, phone) : null,
});
export function newInvitationToken(keyring: Keyring) {
  const token = randomBytes(32).toString("base64url");
  return {
    tokenHash: invitationHash(token),
    tokenEnc: encryptField(keyring, "invitation.token_enc", token),
  };
}
export function invitationRows(tx: Tx, ids: readonly string[]) {
  return tx.invitation.findMany({
    where: { id: { in: [...ids] } },
    include: {
      store: { select: { name: true } },
      inviterMember: {
        select: { displayName: true, merchantUser: { select: { displayName: true } } },
      },
    },
  });
}
export type InvitationRow = Awaited<ReturnType<typeof invitationRows>>[number];
const inviterName = (row: InvitationRow) =>
  row.inviterMember.displayName?.trim() ||
  row.inviterMember.merchantUser.displayName?.trim() ||
  "门店老板";

export async function invitationViewer(tx: Tx, ctx: IdentityContext) {
  if (
    ctx.actor.type !== "merchant" ||
    ctx.actor.client !== "weapp" ||
    !ctx.entityId ||
    !ctx.storeId
  )
    throw new AppError("NOT_A_MEMBER");
  const [viewer, user] = await Promise.all([
    resolveMembership(tx, { merchantUserId: ctx.actor.id, storeId: ctx.storeId }),
    tx.merchantUser.findUnique({ where: { id: ctx.actor.id }, select: { status: true } }),
  ]);
  if (!viewer || viewer.entityId !== ctx.entityId || user?.status !== "active")
    throw new AppError("NOT_A_MEMBER");
  if (viewer.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  if (viewer.storeMode !== "active") throw new AppError("STORE_ARCHIVED");
  return viewer;
}
export type InvitationViewer = Awaited<ReturnType<typeof invitationViewer>>;
export function invitationBinding(tx: Tx, inviterMemberId: string, clientRequestId: string) {
  return tx.invitationRequest.findUnique({
    where: { inviterMemberId_clientRequestId: { inviterMemberId, clientRequestId } },
  });
}
function candidates(tx: Tx, viewer: InvitationViewer) {
  return tx.invitation.findMany({
    where: {
      inviterMemberId: viewer.memberId,
      entityId: viewer.entityId,
      storeId: viewer.storeId,
      status: "pending",
      sharedAt: null,
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
}

export async function lockInvitationContext(
  tx: Tx,
  ctx: IdentityContext,
  input: { clientRequestId?: string; invitationId?: string },
) {
  if (ctx.actor.type !== "merchant" || !ctx.entityId) throw new AppError("NOT_A_MEMBER");
  await lockRows(tx, "merchant_user", [ctx.actor.id], "share");
  await lockRows(tx, "entity", [ctx.entityId]);
  const initial = await invitationViewer(tx, ctx);
  const binding = input.clientRequestId
    ? await invitationBinding(tx, initial.memberId, input.clientRequestId)
    : null;
  if (binding && (binding.entityId !== initial.entityId || binding.storeId !== initial.storeId))
    throw new AppError("NOT_FOUND");
  const found = input.clientRequestId ? await candidates(tx, initial) : [];
  const ids = [
    ...new Set([
      ...found.map((row) => row.id),
      ...(binding ? [binding.invitationId] : []),
      ...(input.invitationId ? [input.invitationId] : []),
    ]),
  ].sort();
  const before = await invitationRows(tx, ids);
  if (
    before.some((row) => row.entityId !== initial.entityId || row.storeId !== initial.storeId) ||
    before.length !== ids.length
  )
    throw new AppError("NOT_FOUND");
  await lockRows(tx, "invitation", ids);
  await lockRows(
    tx,
    "entity_member",
    [...new Set([initial.memberId, ...before.map((row) => row.inviterMemberId)])].sort(),
  );
  await lockRows(tx, "store", [initial.storeId]);
  const viewer = await invitationViewer(tx, ctx);
  if (viewer.memberId !== initial.memberId) throw new AppError("NOT_A_MEMBER");
  const after = input.clientRequestId ? await candidates(tx, viewer) : [];
  const freshBinding = input.clientRequestId
    ? await invitationBinding(tx, viewer.memberId, input.clientRequestId)
    : null;
  if (
    after.map((row) => row.id).join() !== found.map((row) => row.id).join() ||
    freshBinding?.invitationId !== binding?.invitationId
  )
    throw new AppError("PRECONDITION_CHANGED");
  const rows = await invitationRows(tx, ids);
  if (
    rows.length !== ids.length ||
    rows.some((row) => row.entityId !== viewer.entityId || row.storeId !== viewer.storeId)
  )
    throw new AppError("PRECONDITION_CHANGED");
  return { viewer, rows, binding: freshBinding };
}

export async function invitationCard(
  tx: Tx,
  deps: { facts: MerchantFactsReader; keyring: () => Keyring },
  now: Date,
  viewer: InvitationViewer,
  row: InvitationRow,
  isReused: boolean,
): Promise<InvitationCard> {
  if (row.status !== "pending") throw new AppError("STATE_NOT_ALLOWED");
  if (!row.tokenEnc) throw new AppError("INTERNAL");
  const token = decryptField(deps.keyring(), "invitation.token_enc", row.tokenEnc);
  if (
    token.length !== 43 ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !invitationHash(token).equals(Buffer.from(row.tokenHash))
  )
    throw new AppError("INTERNAL");
  const { usage, subscription } = await quotaWithSubscription(tx, deps, now, viewer.entityId);
  const draft = await tx.invitation.findFirst({
    where: {
      entityId: viewer.entityId,
      storeId: viewer.storeId,
      inviterMemberId: viewer.memberId,
      status: "pending",
      sharedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  return {
    invitationId: row.id,
    token,
    isReused,
    role: "clerk",
    storeId: row.storeId,
    storeName: row.store.name,
    inviterName: inviterName(row),
    remarkName: row.remarkName,
    isPhoneRestricted: row.targetPhoneBidx !== null,
    expiresAt: row.expiresAt.toISOString(),
    seats: {
      seatsUsed: usage.seatsUsed,
      memberLimit: usage.memberLimit,
      pendingInvitationCount: usage.pendingInvitationCount,
      includesUnsharedDraft: draft !== null,
      seatsOver: usage.seatsOver,
      limitReason: usage.limitReason,
      planName: subscription?.planName ?? null,
    },
  };
}

export async function invitationPreview(
  tx: Tx,
  facts: MerchantFactsReader,
  now: Date,
  token: string,
): Promise<InvitationPreview> {
  const found = await tx.invitation.findUnique({
    where: { tokenHash: invitationHash(token) },
    select: { id: true },
  });
  if (!found) throw new AppError("INVITATION_INVALID");
  const [row] = await invitationRows(tx, [found.id]);
  if (!row) throw new AppError("INVITATION_INVALID");
  const profile = await facts.source(tx, "profile", {
    entityId: row.entityId,
    storeIds: [row.storeId],
    viewerRole: "owner",
    merchantUserId: null,
    now,
  });
  const detail = profile.stores[row.storeId];
  if (!detail) throw new AppError("INTERNAL");
  return {
    invitationId: row.id,
    status:
      row.status === "pending" && row.expiresAt <= now
        ? "expired"
        : (row.status as InvitationPreview["status"]),
    storeName: row.store.name,
    city: detail.city,
    category: detail.category,
    inviterName: inviterName(row),
    role: "clerk",
    isPhoneRestricted: row.targetPhoneBidx !== null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
