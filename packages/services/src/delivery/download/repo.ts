import { ReleaseManifestItemSchema } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { assertCapability, standingOf, taskScope } from "../../authz/index.js";
import type { DataScope } from "../../authz/index.js";
import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { DeliveryViewer } from "../context.js";
import { lockTickets } from "../repo.js";
export async function viewerOf(tx: Tx, v: DeliveryViewer, sample = false) {
  const actor = v.ctx.actor;
  if (actor.type !== "merchant" || actor.client !== "weapp" || v.membership.role !== "owner")
    throw new AppError("ROLE_FORBIDDEN");
  const member = await tx.entityMember.findFirst({
    where: {
      id: v.membership.memberId,
      merchantUserId: actor.id,
      entityId: v.membership.entityId,
      status: "active",
    },
    include: { entity: true },
  });
  const store = await tx.store.findFirst({
    where: { id: v.membership.storeId, entityId: v.membership.entityId },
  });
  if (!member || !store || member.entity.lifecycle !== "active") throw new AppError("NOT_FOUND");
  if (member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  if (store.lifecycle !== "active" && store.archiveReason !== "by_owner")
    throw new AppError("NOT_FOUND");
  assertCapability(
    standingOf("owner", store.lifecycle === "active" ? "active" : "archived"),
    sample ? "delivery.confirm_sample" : "delivery.download",
  );
  return actor;
}
export async function lockParents(tx: Tx, v: DeliveryViewer, ticketId: string) {
  await lockRows(tx, "entity", [v.membership.entityId], "share");
  await lockRows(tx, "entity_member", [v.membership.memberId], "share");
  await lockRows(tx, "store", [v.membership.storeId], "share");
  await lockTickets(tx, [ticketId]);
}
export async function itemOf(tx: Tx, v: DeliveryViewer, id: string) {
  const r = await tx.orderItem.findFirst({
    where: { id, entityId: v.membership.entityId, storeId: v.membership.storeId },
    include: { dramaOrder: true, deliveryTicket: true },
  });
  if (
    !r ||
    r.dramaOrder.entityId !== r.entityId ||
    r.dramaOrder.storeId !== r.storeId ||
    (r.deliveryTicket &&
      (r.deliveryTicket.entityId !== r.entityId ||
        r.deliveryTicket.storeId !== r.storeId ||
        r.deliveryTicket.dramaOrderId !== r.dramaOrderId))
  )
    throw new AppError("NOT_FOUND");
  return r;
}
export type DownloadItem = Awaited<ReturnType<typeof itemOf>>;
export async function currentRelease(tx: Tx, item: DownloadItem) {
  const where = {
    orderItemId: item.id,
    entityId: item.entityId,
    storeId: item.storeId,
    ...(item.deliveryTicket ? { deliveryTicketId: item.deliveryTicket.id } : {}),
  };
  return (
    (await tx.deliveryRelease.findFirst({
      where: { ...where, state: "pushed" },
      orderBy: { releaseNo: "desc" },
    })) ?? (await tx.deliveryRelease.findFirst({ where, orderBy: { releaseNo: "desc" } }))
  );
}
export async function grantOf(tx: Tx, releaseId: string, item: DownloadItem) {
  const where = {
    deliveryReleaseId: releaseId,
    orderItemId: item.id,
    entityId: item.entityId,
    storeId: item.storeId,
    granteeType: "entity",
    granteeId: item.entityId,
  };
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  return (
    (await tx.downloadGrant.findFirst({ where: { ...where, state: "active" }, orderBy })) ??
    (await tx.downloadGrant.findFirst({ where, orderBy }))
  );
}
export const manifestOf = (value: Prisma.JsonValue) =>
  ReleaseManifestItemSchema.array().parse(value);
export const scopedTickets = (scope: DataScope) =>
  taskScope<Prisma.DeliveryTicketWhereInput>(scope, {
    assignees: [
      { col: "deliveryManagerId", pool: "store_manager" },
      { col: "editorId" },
      { col: "publisherId", pool: "ticket_publisher" },
    ],
  });
