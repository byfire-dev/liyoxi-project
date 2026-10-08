import type { Tx } from "../kernel/index.js";
export async function storeForNotify(tx: Tx, id: string) {
  const row = await tx.store.findUnique({ where: { id } });
  return row
    ? {
        bizType: "store",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.id,
        status: row.qualificationStatus,
        version: 0,
        name: row.name,
      }
    : null;
}
