import type { Tx } from "../kernel/index.js";
export async function accountNoticeFact(tx: Tx, id: string) {
  const row = await tx.channelAccount.findUnique({ where: { id } });
  return row
    ? {
        bizType: "channel_account",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.status,
        version: 0,
        name: "发布账号",
      }
    : null;
}
export async function launchNoticeFact(tx: Tx, id: string) {
  const row = await tx.launchTask.findUnique({ where: { id } });
  return row
    ? {
        bizType: "launch_task",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.reviewStatus,
        version: row.currentRoundNo,
        name: "上线核验",
        orderItemId: row.orderItemId,
        deliveryTicketId: row.deliveryTicketId,
      }
    : null;
}

export async function launchLinkForItem(tx: Tx, orderItemId: string) {
  const task = await tx.launchTask.findFirst({
    where: { orderItemId, reviewStatus: { not: "void" } },
    select: { id: true, storeId: true },
    orderBy: { id: "asc" },
  });
  return task
    ? { route: "publish.task", params: { launchTaskId: task.id, storeId: task.storeId } }
    : null;
}
