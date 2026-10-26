import type { FileRefType, Tx } from "../../kernel/index.js";
/** 回单有业务列；双人放弃凭证由同事务追加的审计事实永久持有，不能用file_ref自证在用。 */
async function evidence(tx: Tx, fileId?: string) {
  const logs = await tx.auditLog.findMany({
    where: {
      action: "finance.refund.abandon_txn",
      targetType: "refund_txn",
      ...(fileId ? { meta: { path: ["evidenceFileId"], equals: fileId } } : {}),
    },
    select: { targetId: true, meta: true },
  });
  return logs.flatMap((log) => {
    const meta = log.meta;
    return log.targetId &&
      meta &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      typeof meta.evidenceFileId === "string"
      ? [{ fileId: meta.evidenceFileId, refId: log.targetId, role: "abandon_evidence" }]
      : [];
  });
}
export const refundFileRefs: FileRefType = {
  roles: {
    receipt: { categories: ["pay_receipt"], retentionDays: null },
    abandon_evidence: { categories: ["pay_receipt"], retentionDays: null },
  },
  async inUse(tx, fileId) {
    const receipts = await tx.refundTxn.findMany({
      where: { receiptFileId: fileId },
      select: { id: true },
    });
    return [
      ...receipts.map((row) => ({ fileId, refId: row.id, role: "receipt" })),
      ...(await evidence(tx, fileId)),
    ];
  },
  async readColumns(tx) {
    const receipts = await tx.refundTxn.findMany({
      where: { receiptFileId: { not: null } },
      select: { id: true, receiptFileId: true },
    });
    return [
      ...receipts.map((row) => ({ fileId: row.receiptFileId!, refId: row.id, role: "receipt" })),
      ...(await evidence(tx)),
    ];
  },
};
