import type { TransactionConsentFact, Tx } from "../kernel/index.js";
export async function billingOrderForNotify(tx: Tx, id: string) {
  const row = await tx.billingOrder.findUnique({ where: { id } });
  return row
    ? {
        bizType: "billing_order",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.status,
        version: 0,
        name: row.orderNo,
        amountFen: row.amountFen,
        detail: row.type === "plan_renew" ? "服务已续期" : "服务已开通",
        ...(row.paidAt ? { occurredAt: row.paidAt.toISOString() } : {}),
      }
    : null;
}
export async function termForNotify(tx: Tx, id: string) {
  const row = await tx.subscriptionTerm.findUnique({ where: { id } });
  return row
    ? {
        bizType: "subscription_term",
        bizId: row.id,
        entityId: row.entityId,
        storeId: null,
        status: row.status,
        version: row.termNo,
        name: `第${row.termNo}期套餐`,
      }
    : null;
}
export async function billingAccountForNotify(tx: Tx, entityId: string) {
  const row = await tx.billingAccount.findUnique({ where: { entityId } });
  return row
    ? {
        bizType: "billing_account",
        bizId: row.entityId,
        entityId: row.entityId,
        storeId: null,
        status: row.subStatus,
        version: 0,
        name: "积分账户",
        balance: row.planAvailableQty + row.addonAvailableQty,
      }
    : null;
}

export async function transferForNotify(tx: Tx, id: string) {
  const row = await tx.transferProof.findUnique({
    where: { id },
    include: { billingOrder: { select: { orderNo: true, storeId: true } } },
  });
  return row
    ? {
        bizType: "transfer_proof",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.billingOrder.storeId,
        status: row.reviewStatus,
        version: row.uploadNo,
        name: row.billingOrder.orderNo,
      }
    : null;
}
export async function paymentExceptionForNotify(tx: Tx, id: string) {
  const row = await tx.paymentException.findUnique({ where: { id } });
  return row
    ? {
        bizType: "payment_exception",
        bizId: row.id,
        entityId: row.entityId,
        storeId: null,
        status: row.status,
        version: row.lockVersion,
        name: row.exceptionNo,
      }
    : null;
}

export async function billingConsentFacts(tx: Tx): Promise<TransactionConsentFact[]> {
  return (
    await tx.billingOrder.findMany({
      where: { source: "weapp", status: { in: ["paid", "refunded"] } },
      select: { id: true, orderNo: true, entityId: true, placedByUserId: true, createdAt: true },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    bizType: "billing_order",
    bizId: row.id,
    bizNo: row.orderNo,
    entityId: row.entityId,
    merchantUserId: row.placedByUserId,
    at: row.createdAt,
    agreementKeys: ["member", "points"],
  }));
}
