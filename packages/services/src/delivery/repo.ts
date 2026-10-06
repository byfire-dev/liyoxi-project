import type { Prisma } from "@liyoxi/db";
import { hasPermission, taskScope, storeScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { DeliveryViewer } from "./context.js";
export const itemInclude = {
  orderItemAccounts: { include: { channelAccount: true } },
  orderItemPlacements: { include: { ad: true } },
  pointHold: true,
} as const;
export const planInclude = {
  store: { include: { entity: true, storeProfileStore: true } },
  dramaOrder: {
    include: { orderItems: { include: itemInclude }, deliveryTickets: true, deliveryManager: true },
  },
  deliveryPlanVersions: {
    include: { pushedByStaff: true },
    orderBy: { versionNo: "desc" as const },
  },
  deliveryPlanChangeRequests: {
    include: { createdByUser: true },
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  },
} satisfies Prisma.DeliveryPlanInclude;
export const ticketInclude = {
  store: { include: { entity: true, storeProfileStore: true } },
  orderItem: { include: itemInclude },
  dramaOrder: {
    include: {
      deliveryPlan: { include: planInclude },
      deliveryTickets: { include: { orderItem: true } },
    },
  },
  deliveryManager: true,
  editor: true,
  publisher: true,
  deliveryTicketStages: { orderBy: [{ enteredAt: "asc" as const }, { id: "asc" as const }] },
  deliveryTicketPauses: { where: { releasedAt: null } },
  launchTasks: {
    where: { reviewStatus: { not: "void" } },
    include: { channelAccount: true, launchSubmissions: true },
  },
  episodeOutputs: { where: { isCurrent: true } },
  qcRecords: { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }] },
} satisfies Prisma.DeliveryTicketInclude;
export type TicketRow = Prisma.DeliveryTicketGetPayload<{ include: typeof ticketInclude }>;
export type PlanRow = Prisma.DeliveryPlanGetPayload<{ include: typeof planInclude }>;
export function ticketScope(staff: StaffContext): Prisma.DeliveryTicketWhereInput {
  const scope = taskScope<Prisma.DeliveryTicketWhereInput>(staff.scope, {
    assignees: [
      {
        col: "deliveryManagerId",
        ...(staff.staff.isLead && hasPermission(staff, "merchant.manager.assign")
          ? { pool: "store_manager" as const }
          : {}),
      },
      { col: "editorId" },
      { col: "publisherId", pool: "ticket_publisher" },
    ],
  });
  return staff.moduleLevels.delivery === "o"
    ? { AND: [scope, { OR: [{ editorId: staff.staff.id }, { publisherId: staff.staff.id }] }] }
    : scope;
}
export async function ticketOf(tx: Tx, id: string, staff?: StaffContext) {
  const r = await tx.deliveryTicket.findFirst({
    where: { id, ...(staff ? ticketScope(staff) : {}) },
    include: ticketInclude,
  });
  if (!r) throw new AppError("NOT_FOUND");
  return r;
}
export function assertOwner(viewer: DeliveryViewer) {
  if (viewer.membership.role !== "owner" || viewer.ctx.actor.type !== "merchant")
    throw new AppError("ROLE_FORBIDDEN");
}
export async function planOf(tx: Tx, id: string, subject?: StaffContext | DeliveryViewer) {
  const scope =
    subject &&
    ("membership" in subject
      ? { storeId: subject.membership.storeId, entityId: subject.membership.entityId }
      : { store: storeScope(subject.scope) });
  const r = await tx.deliveryPlan.findFirst({ where: { id, ...scope }, include: planInclude });
  if (!r) throw new AppError("NOT_FOUND");
  return r;
}
/** 父行必须先锁；callbacks 可重入已锁父行，不允许在更晚的锁之后才发现新父行。 */
export async function lockTickets(tx: Tx, ids: readonly string[]) {
  const rows = await tx.deliveryTicket.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, dramaOrderId: true, orderItemId: true },
  });
  await lockRows(
    tx,
    "drama_order",
    rows.map((r) => r.dramaOrderId),
  );
  await lockRows(
    tx,
    "order_item",
    rows.map((r) => r.orderItemId),
  );
  await lockRows(
    tx,
    "delivery_ticket",
    rows.map((r) => r.id),
  );
}
export const iso = (value: Date | null) => value?.toISOString() ?? null;
export const dateOf = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
