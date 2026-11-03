import type { Prisma } from "@liyoxi/db";
import { addDays, calendarDate, diffDays } from "@liyoxi/shared/time";
import type { Tx } from "../kernel/index.js";

export interface LaunchOverdueTaskFact {
  id: string;
  reviewStatus: string;
  isLive: boolean;
}
export interface LaunchOverdueFacts {
  orderItemId: string;
  agreedLaunchDate: Date | null;
  usageEndDate: Date;
  phase: string;
  deliveredAt: Date | null;
  pauseCount: number;
  tasks: readonly LaunchOverdueTaskFact[];
}
export interface OverdueLaunchItem {
  orderItemId: string;
  agreedLaunchDate: string;
  overdueStartDate: string;
  overdueDays: number;
  reason: "merchant" | "late_delivery";
  overdueTaskIds: string[];
}

/** a06 §3.14 的唯一当前逾期口径；日期列用 UTC 日期，交付时刻按北京时间取日。 */
export function deriveLaunchOverdue(
  facts: LaunchOverdueFacts,
  now: Date,
): OverdueLaunchItem | null {
  const today = calendarDate(now);
  const agreed = facts.agreedLaunchDate?.toISOString().slice(0, 10);
  if (
    !agreed ||
    agreed >= today ||
    !facts.deliveredAt ||
    facts.pauseCount > 0 ||
    !["to_launch", "live"].includes(facts.phase) ||
    today > facts.usageEndDate.toISOString().slice(0, 10)
  )
    return null;
  const tasks = facts.tasks.filter(
    (task) => !task.isLive && ["pending", "need_fix"].includes(task.reviewStatus),
  );
  if (!tasks.length) return null;
  const delivered = calendarDate(facts.deliveredAt);
  const start = addDays(delivered > agreed ? delivered : agreed, 1);
  return {
    orderItemId: facts.orderItemId,
    agreedLaunchDate: agreed,
    overdueStartDate: start,
    // 当日刚晚交付的任务满足逾期筛选，但从交付次日起算，今天为 0 天。
    overdueDays: Math.max(0, diffDays(today, start) + 1),
    reason: delivered > agreed ? "late_delivery" : "merchant",
    overdueTaskIds: tasks.map((task) => task.id),
  };
}

/** 工单数据范围由调用方传入；提醒扫描可不传，交给通知收件人规则继续筛选。 */
export async function listOverdueLaunchItems(
  tx: Tx,
  now: Date,
  where: Prisma.DeliveryTicketWhereInput = {},
) {
  const today = new Date(calendarDate(now));
  const tickets = await tx.deliveryTicket.findMany({
    where: {
      AND: [
        where,
        {
          pauseCount: 0,
          deliveredAt: { not: null },
          orderItem: {
            agreedLaunchDate: { lt: today },
            usageEndDate: { gte: today },
            phase: { in: ["to_launch", "live"] },
          },
          launchTasks: { some: { isLive: false, reviewStatus: { in: ["pending", "need_fix"] } } },
        },
      ],
    },
    include: { orderItem: true, launchTasks: true },
    orderBy: { id: "asc" },
  });
  return tickets.flatMap((ticket) => {
    const overdue = deriveLaunchOverdue(
      {
        orderItemId: ticket.orderItemId,
        agreedLaunchDate: ticket.orderItem.agreedLaunchDate,
        usageEndDate: ticket.orderItem.usageEndDate,
        phase: ticket.orderItem.phase,
        deliveredAt: ticket.deliveredAt,
        pauseCount: ticket.pauseCount,
        tasks: ticket.launchTasks,
      },
      now,
    );
    return overdue
      ? [
          {
            ...overdue,
            deliveryTicketId: ticket.id,
            entityId: ticket.entityId,
            storeId: ticket.storeId,
            deliveryManagerId: ticket.deliveryManagerId,
            dramaTitle: (ticket.orderItem.dramaSnapshot as { title?: string }).title ?? "",
          },
        ]
      : [];
  });
}
export async function countOverdueLaunchItems(
  tx: Tx,
  now: Date,
  where: Prisma.DeliveryTicketWhereInput = {},
) {
  return (await listOverdueLaunchItems(tx, now, where)).length;
}
