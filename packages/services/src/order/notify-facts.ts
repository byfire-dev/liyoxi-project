import type { TransactionConsentFact, Tx } from "../kernel/index.js";
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
