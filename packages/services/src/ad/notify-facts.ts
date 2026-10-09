import type { TransactionConsentFact, Tx } from "../kernel/index.js";
export async function adConsentFacts(tx: Tx): Promise<TransactionConsentFact[]> {
  return (
    await tx.ad.findMany({
      select: {
        id: true,
        adNo: true,
        entityId: true,
        requestedByUserId: true,
        submittedAt: true,
        agreementConsentId: true,
      },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    bizType: "ad",
    bizId: row.id,
    bizNo: row.adNo,
    entityId: row.entityId,
    merchantUserId: row.requestedByUserId,
    at: row.submittedAt,
    agreementKeys: ["ad_service"],
    consentId: row.agreementConsentId,
  }));
}
