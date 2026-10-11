import type { Tx } from "../kernel/index.js";

/** 所有账号绑定历史均计入，包括已解绑和审核拒绝。 */
export function countStoreChannelAccountHistory(
  tx: Tx,
  input: { entityId: string; storeId: string },
) {
  return tx.channelAccount.count({ where: input });
}
