import type { FileRefType } from "../../kernel/index.js";
export const billFileRefs: FileRefType = {
  roles: { main: { categories: ["pay_bill"], retentionDays: null } },
  async inUse(tx, fileId) {
    return (await tx.wxBillFile.findMany({ where: { fileId }, select: { id: true } })).map((r) => ({
      fileId,
      refId: r.id,
      role: "main",
    }));
  },
  async readColumns(tx) {
    return (
      await tx.wxBillFile.findMany({
        where: { fileId: { not: null } },
        select: { id: true, fileId: true },
      })
    ).map((r) => ({ fileId: r.fileId!, refId: r.id, role: "main" }));
  },
};
