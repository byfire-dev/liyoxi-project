import type { TransactionConsentFact, Tx } from "../kernel/index.js";
import { readOrderQualificationRound } from "../profile/index.js";
export async function orderForNotify(tx: Tx, id: string) {
  const row = await tx.dramaOrder.findUnique({ where: { id } });
  return row
    ? {
        bizType: "drama_order",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.status,
        version: 0,
        name: row.orderNo,
        orderId: row.id,
      }
    : null;
}

export async function orderConsentFacts(tx: Tx): Promise<TransactionConsentFact[]> {
  return (
    await tx.dramaOrder.findMany({
      select: {
        id: true,
        orderNo: true,
        entityId: true,
        placedByUserId: true,
        submittedAt: true,
        agreementConsentId: true,
      },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    bizType: "drama_order",
    bizId: row.id,
    bizNo: row.orderNo,
    entityId: row.entityId,
    merchantUserId: row.placedByUserId,
    at: row.submittedAt,
    agreementKeys: ["custom_license"],
    consentId: row.agreementConsentId,
  }));
}

/** 重新读取当前轮次，过期事件不能在资质恢复或重新送审后生成客服待办。 */
export async function orderRejectedForNotify(tx: Tx, id: string) {
  const row = await tx.dramaOrder.findUnique({ where: { id }, include: { store: true } });
  if (
    !row ||
    row.status !== "pending_start" ||
    row.openCancelRequestId ||
    row.store.qualificationStatus !== "rejected"
  )
    return null;
  const round = await readOrderQualificationRound(tx, {
    entityId: row.entityId,
    storeId: row.storeId,
  });
  if (
    !round ||
    round.outcome !== "rejected" ||
    round.approvalStatus !== "rejected" ||
    !round.closedAt ||
    round.finalRejectedAt
  )
    return null;
  return {
    bizType: "drama_order",
    bizId: row.id,
    entityId: row.entityId,
    storeId: row.storeId,
    status: row.status,
    version: round.roundNo,
    name: row.orderNo,
    orderId: row.id,
    occurredAt: round.closedAt.toISOString(),
    summary: `订购单${row.orderNo}资质驳回后超期未补正，请跟进商家。`,
  };
}
