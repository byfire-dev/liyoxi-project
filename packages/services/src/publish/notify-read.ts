import { IdSchema } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";

/** 通知框架回库取当前事实；不签链接，不发通知，不读取敏感原图。 */
export async function channelAccountForNotify(tx: Tx, id: string) {
  const account = await tx.channelAccount.findUnique({ where: { id: IdSchema.parse(id) } });
  if (!account) return null;
  return {
    channelAccountId: account.id,
    entityId: account.entityId,
    storeId: account.storeId,
    platform: account.platform,
    accountName: account.accountName,
    status: account.status,
    abnormalSource: account.abnormalSource,
    reasonCode: account.abnormalReasonCode,
    note: account.abnormalNote,
  };
}
export async function launchTaskForNotify(tx: Tx, id: string) {
  const task = await tx.launchTask.findUnique({
    where: { id: IdSchema.parse(id) },
    include: { channelAccount: { select: { accountName: true } } },
  });
  if (!task) return null;
  return {
    launchTaskId: task.id,
    entityId: task.entityId,
    storeId: task.storeId,
    orderItemId: task.orderItemId,
    deliveryTicketId: task.deliveryTicketId,
    accountName: task.channelAccount.accountName,
    platform: task.platform,
    reviewStatus: task.reviewStatus,
    currentRoundNo: task.currentRoundNo,
    verifiedEpisodeCount: task.verifiedEpisodeCount,
    isLive: task.isLive,
    firstLaunchDate: task.firstLaunchDate?.toISOString().slice(0, 10) ?? null,
  };
}
