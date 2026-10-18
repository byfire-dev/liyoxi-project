import type { Tx } from "../kernel/index.js";

export async function readOrderAssetUsage(
  tx: Tx,
  input: { usedByType: string; usedById: string; entityId: string; storeId: string },
) {
  const scope = { entityId: input.entityId, storeId: input.storeId };
  const row =
    input.usedByType === "drama_order"
      ? await tx.dramaOrder.findFirst({
          where: { id: input.usedById, ...scope },
          select: { id: true, orderNo: true },
        })
      : input.usedByType === "order_item"
        ? (
            await tx.orderItem.findFirst({
              where: { id: input.usedById, ...scope },
              select: { dramaOrder: { select: { id: true, orderNo: true } } },
            })
          )?.dramaOrder
        : null;
  return row ? { type: "drama_order" as const, id: row.id, no: row.orderNo } : null;
}
