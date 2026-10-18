import type { Tx } from "../kernel/index.js";

export async function readEpisodeAssetOrder(
  tx: Tx,
  input: { usedById: string; entityId: string; storeId: string },
) {
  const row = await tx.episodeOutput.findFirst({
    where: { id: input.usedById, entityId: input.entityId, storeId: input.storeId },
    select: { deliveryTicket: { select: { dramaOrderId: true } } },
  });
  return row?.deliveryTicket.dramaOrderId ?? null;
}

export async function hasAssetEditingTicket(tx: Tx, input: { storeId: string; staffId: string }) {
  return (
    (await tx.deliveryTicket.count({
      where: {
        storeId: input.storeId,
        editorId: input.staffId,
        archivedAt: null,
        terminatedAt: null,
      },
    })) > 0
  );
}
