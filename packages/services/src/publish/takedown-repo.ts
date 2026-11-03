import type { Prisma } from "@liyoxi/db";
import type { AdminTakedownTaskSummaryQuery } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { assertAccess, hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { PublishViewer } from "./context.js";
import { ticketScope } from "./repo.js";
import { owner } from "./validate.js";
export const takedownInclude = {
  channelAccount: true,
  orderItem: { include: { dramaOrder: true } },
  deliveryTicket: { include: { deliveryTicketPauses: true } },
} satisfies Prisma.TakedownTaskInclude;
export type TakedownRow = Prisma.TakedownTaskGetPayload<{ include: typeof takedownInclude }>;
export const expectedChecklist = (row: Pick<TakedownRow, "basis">) =>
  row.basis === "live" ? ("takedown.check" as const) : ("takedown.absence_check" as const);
export const allowedMethods = (row: Pick<TakedownRow, "basis">) =>
  row.basis === "live"
    ? (["delete", "private"] as const)
    : (["delete", "private", "not_published"] as const);
export function takedownAccess(staff: StaffContext) {
  assertAccess(staff, { module: { module: "publish", need: "view" }, permission: null });
}
export function mayWrite(staff: StaffContext, row: TakedownRow, breach = false) {
  return (
    hasPermission(staff, breach ? "publish.takedown.breach_notice" : "publish.takedown.check") &&
    (staff.moduleLevels.publish !== "o" || row.deliveryTicket.publisherId === staff.staff.id)
  );
}
export function assertTakedownStaff(staff: StaffContext, row: TakedownRow, breach = false) {
  if (!mayWrite(staff, row, breach)) throw new AppError("PERMISSION_DENIED");
}
export function takedownWhere(
  staff: StaffContext,
  query: AdminTakedownTaskSummaryQuery,
  now: Date,
): Prisma.TakedownTaskWhereInput {
  const today = new Date(calendarDate(now));
  return {
    AND: [
      { deliveryTicket: ticketScope(staff) },
      { status: { not: "void" } },
      ...(query.storeId ? [{ storeId: query.storeId }] : []),
      ...(query.orderItemId ? [{ orderItemId: query.orderItemId }] : []),
      ...(query.basis ? [{ basis: query.basis }] : []),
      ...(query.isOverdue === undefined
        ? []
        : [
            query.isOverdue
              ? { status: "pending_merchant", dueDate: { lt: today } }
              : { OR: [{ status: { not: "pending_merchant" } }, { dueDate: { gte: today } }] },
          ]),
      ...(query.dueFrom || query.dueTo
        ? [
            {
              dueDate: {
                ...(query.dueFrom ? { gte: new Date(query.dueFrom) } : {}),
                ...(query.dueTo ? { lte: new Date(query.dueTo) } : {}),
              },
            },
          ]
        : []),
      ...(query.q
        ? [
            {
              OR: [
                { store: { name: { contains: query.q, mode: "insensitive" as const } } },
                {
                  channelAccount: {
                    accountName: { contains: query.q, mode: "insensitive" as const },
                  },
                },
                {
                  orderItem: {
                    dramaOrder: { orderNo: { contains: query.q, mode: "insensitive" as const } },
                  },
                },
                { orderItem: { dramaSnapshot: { path: ["title"], string_contains: query.q } } },
              ],
            },
          ]
        : []),
    ],
  };
}
async function scopedTakedown(
  tx: Tx,
  id: string,
  access: StaffContext | PublishViewer | undefined,
  includeVoid: boolean,
) {
  const merchant = access && "membership" in access ? access : null;
  if (merchant) owner(merchant);
  const row = await tx.takedownTask.findFirst({
    where: {
      id,
      ...(includeVoid ? {} : { status: { not: "void" } }),
      ...(merchant
        ? { entityId: merchant.membership.entityId, storeId: merchant.membership.storeId }
        : {}),
      ...(access && "staff" in access ? { deliveryTicket: ticketScope(access) } : {}),
    },
    include: takedownInclude,
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

export const takedownOf = (tx: Tx, id: string, access?: StaffContext | PublishViewer) =>
  scopedTakedown(tx, id, access, false);

// A stale write must distinguish an in-scope void task from a missing/foreign task.
// The writer's state guard returns 409; read projections continue to hide void rows.
export const takedownForWrite = (tx: Tx, id: string, access: StaffContext | PublishViewer) =>
  scopedTakedown(tx, id, access, true);
