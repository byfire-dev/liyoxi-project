import { byStore, hasPermission, taskScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Prisma } from "@liyoxi/db";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
export const accountInclude = {
  store: { include: { entity: true, storeProfileStore: true } },
  channelAccountSubmissions: {
    include: { approvalRequest: true },
    orderBy: { roundNo: "desc" as const },
  },
};
export const launchInclude = {
  channelAccount: true,
  orderItem: { include: { dramaOrder: true } },
  deliveryTicket: { include: { deliveryTicketPauses: true } },
  launchSubmissions: { include: { approvalRequest: true }, orderBy: { roundNo: "desc" as const } },
};
export async function accountOf(tx: Tx, id: string, staff?: StaffContext, roleQueue = false) {
  const row = await tx.channelAccount.findFirst({
    where: {
      id,
      ...(staff && !(roleQueue && hasPermission(staff, "publish.account.verify"))
        ? byStore(staff.scope)
        : {}),
    },
    include: accountInclude,
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
export function ticketScope(staff: StaffContext): Prisma.DeliveryTicketWhereInput {
  return taskScope<Prisma.DeliveryTicketWhereInput>(staff.scope, {
    store: (store) => ({ store }),
    assignees: [{ col: "publisherId", pool: "ticket_publisher" }, { col: "deliveryManagerId" }],
  });
}
export async function taskOf(tx: Tx, id: string, staff?: StaffContext) {
  const row = await tx.launchTask.findFirst({
    where: { id, ...(staff ? { deliveryTicket: ticketScope(staff) } : {}) },
    include: launchInclude,
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
export async function lockTask(tx: Tx, id: string) {
  const first = await taskOf(tx, id);
  await lockRows(tx, "drama_order", [first.orderItem.dramaOrderId]);
  await lockRows(tx, "order_item", [first.orderItemId]);
  await lockRows(tx, "delivery_ticket", [first.deliveryTicketId]);
  await lockRows(tx, "launch_task", [id]);
  return taskOf(tx, id);
}
export const dictRef = async (tx: Tx, type: string, code: string | null) => {
  if (!code) return null;
  const r = await tx.dictItem.findUnique({
    where: { dictTypeKey_code: { dictTypeKey: type, code } },
  });
  return { code, name: r?.name ?? code };
};
export const reasons = async (tx: Tx, codes: readonly string[]) =>
  Promise.all(codes.map((c) => dictRef(tx, "reject_reason", c)));
export async function staffBrief(tx: Tx, id: string | null) {
  if (!id) return null;
  const r = await tx.staff.findUnique({
    where: { id },
    select: { id: true, staffNo: true, name: true, staffRoleKey: true, isLead: true, status: true },
  });
  return r
    ? {
        staffId: r.id,
        staffNo: r.staffNo,
        name: r.name,
        roleKey: r.staffRoleKey,
        isLead: r.isLead,
        status: r.status,
      }
    : null;
}
export async function actorName(tx: Tx, type: string, id: string | null, entityId: string) {
  if (!id) return null;
  if (type === "staff") return (await staffBrief(tx, id))?.name ?? null;
  const member = await tx.entityMember.findFirst({
    where: { entityId, merchantUserId: id },
    include: { merchantUser: true },
  });
  return member?.displayName ?? member?.merchantUser.displayName ?? "商家";
}
export const iso = (date: Date | null) => date?.toISOString() ?? null;
export const dateOf = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
export const snapshotOf = (value: Prisma.JsonValue) =>
  value as { title?: string; posterFileId?: string };
export const episodeUrlsOf = (value: Prisma.JsonValue | null) =>
  (value ?? []) as Array<{ episodeNo: number; url: string }>;
export type AccountRow = Awaited<ReturnType<typeof accountOf>>;
export type TaskRow = Awaited<ReturnType<typeof taskOf>>;
