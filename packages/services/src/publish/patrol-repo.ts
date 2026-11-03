import type { Prisma } from "@liyoxi/db";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import type { StaffContext } from "../authz/index.js";
import { hasPermission } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { taskOf, ticketScope } from "./repo.js";
import { invalid } from "./validate.js";
import type { PatrolFilter } from "./patrol-context.js";
export const patrolInclude = {
  patrolBatch: true,
  launchTask: { include: { channelAccount: true } },
  orderItem: { include: { dramaOrder: true } },
  deliveryTicket: { include: { deliveryTicketPauses: true } },
} satisfies Prisma.PatrolTaskInclude;
export function weekOf(now: Date, supplied?: string) {
  const date = supplied ?? calendarDate(now);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  if (supplied && weekday !== 1) throw invalid("weekStartDate", "周起始日须为周一");
  return supplied ?? addDays(date, 1 - weekday);
}
export function patrolWhere(
  staff: StaffContext,
  query: PatrolFilter,
  now: Date,
): Prisma.PatrolTaskWhereInput {
  const week = weekOf(now, query.weekStartDate);
  return {
    deliveryTicket: ticketScope(staff),
    ...(query.openOnly
      ? { status: { in: ["pending", "abnormal"] } }
      : {
          status: { not: "void" },
          patrolBatch: { weekStartDate: new Date(week) },
        }),
    ...(query.storeId ? { storeId: query.storeId } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.q
      ? {
          OR: [
            { store: { name: { contains: query.q, mode: "insensitive" } } },
            {
              launchTask: {
                channelAccount: { accountName: { contains: query.q, mode: "insensitive" } },
              },
            },
            { orderItem: { dramaSnapshot: { path: ["title"], string_contains: query.q } } },
          ],
        }
      : {}),
  };
}
export async function patrolOf(tx: Tx, id: string, staff?: StaffContext) {
  const row = await tx.patrolTask.findFirst({
    where: { id, ...(staff ? { deliveryTicket: ticketScope(staff) } : {}) },
    include: patrolInclude,
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
export function assertPatrolStaff(staff: StaffContext, publisherId: string | null) {
  if (
    !hasPermission(staff, "publish.patrol.do") ||
    (staff.moduleLevels.publish === "o" && publisherId !== staff.staff.id)
  )
    throw new AppError("PERMISSION_DENIED");
}
export function eligible(task: Awaited<ReturnType<typeof taskOf>>, now: Date) {
  const reason =
    !task.isLive || task.reviewStatus === "void"
      ? "task_not_live"
      : task.orderItem.phase !== "live"
        ? "item_not_live"
        : task.deliveryTicket.step !== "in_service"
          ? "ticket_not_in_service"
          : !task.orderItem.usageEndDate ||
              task.orderItem.usageEndDate.toISOString().slice(0, 10) < calendarDate(now)
            ? "item_not_live"
            : null;
  if (reason) throw new AppError("PATROL_NOT_ELIGIBLE", { details: { reason } });
}
/** Lock the parents before launch so expiry, cancellation and manual writers serialize. */
export async function lockPatrolLaunch(tx: Tx, launchTaskId: string, staff?: StaffContext) {
  const first = await taskOf(tx, launchTaskId, staff);
  await lockRows(tx, "drama_order", [first.orderItem.dramaOrderId]);
  await lockRows(tx, "order_item", [first.orderItemId]);
  await lockRows(tx, "delivery_ticket", [first.deliveryTicketId]);
  await lockRows(tx, "launch_task", [first.id]);
  return taskOf(tx, launchTaskId, staff);
}
export type PatrolRow = Awaited<ReturnType<typeof patrolOf>>;
