import type { Tx } from "../kernel/index.js";

/** m05 第1.2节：门店停用只排除已归档、已终止工单，包含到期下架中的工单。 */
export function countBlockingStoreTickets(tx: Tx, storeId: string): Promise<number> {
  return tx.deliveryTicket.count({
    where: { storeId, step: { notIn: ["archived", "terminated"] } },
  });
}

/** 主体注销/关闭的 release_online：按工单步骤计数，不按成片包或上线任务重复计数。 */
export function countOnlineReleaseTicketsByEntity(tx: Tx, entityId: string): Promise<number> {
  return tx.deliveryTicket.count({
    where: {
      entityId,
      step: { in: ["awaiting_launch", "launch_verify", "in_service", "takedown"] },
    },
  });
}
