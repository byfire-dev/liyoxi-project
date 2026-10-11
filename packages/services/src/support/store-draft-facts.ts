import type { Tx } from "../kernel/index.js";

/** 已关闭和取消的客服工单也属于业务历史。 */
export function countStoreServiceTicketHistory(
  tx: Tx,
  input: { entityId: string; storeId: string },
) {
  return tx.serviceTicket.count({ where: input });
}
