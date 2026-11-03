import { calendarDate } from "@liyoxi/shared/time";
import type { Tx } from "../kernel/index.js";

/** 通知消费者读取当前业务事实；终态、撤销上线与非服务中对象不再催办。 */
export async function patrolNoticeFact(tx: Tx, id: string, input: { now: Date }) {
  const row = await tx.patrolTask.findUnique({
    where: { id },
    select: {
      id: true,
      entityId: true,
      storeId: true,
      status: true,
      launchTaskId: true,
      orderItemId: true,
      deliveryTicketId: true,
      launchTask: {
        select: {
          entityId: true,
          storeId: true,
          orderItemId: true,
          deliveryTicketId: true,
          isLive: true,
          reviewStatus: true,
        },
      },
      orderItem: { select: { phase: true, usageEndDate: true } },
      deliveryTicket: { select: { step: true } },
    },
  });
  if (
    !row ||
    !["abnormal", "recovered"].includes(row.status) ||
    !row.launchTask.isLive ||
    row.launchTask.reviewStatus === "void" ||
    row.orderItem.phase !== "live" ||
    !row.orderItem.usageEndDate ||
    row.orderItem.usageEndDate.toISOString().slice(0, 10) < calendarDate(input.now) ||
    row.deliveryTicket.step !== "in_service" ||
    row.launchTask.entityId !== row.entityId ||
    row.launchTask.storeId !== row.storeId ||
    row.launchTask.orderItemId !== row.orderItemId ||
    row.launchTask.deliveryTicketId !== row.deliveryTicketId
  )
    return null;
  const recovered = row.status === "recovered";
  return {
    bizType: "patrol_task",
    bizId: row.id,
    entityId: row.entityId,
    storeId: row.storeId,
    status: row.status,
    // 每个任务只进入一次异常；恢复后版本变化，旧异常外发通过既有重验取消。
    version: recovered ? 2 : 1,
    name: "作品巡检",
    orderItemId: row.orderItemId,
    deliveryTicketId: row.deliveryTicketId,
    guardBizType: "launch_task" as const,
    guardBizId: row.launchTaskId,
    summary: recovered
      ? "作品巡检已复查恢复，请查看上线记录。"
      : "作品巡检发现异常，请查看上线记录并处理。",
    link: {
      route: "publish.task" as const,
      params: { launchTaskId: row.launchTaskId, storeId: row.storeId },
    },
  };
}
