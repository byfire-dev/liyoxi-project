import type { Tx } from "../kernel/index.js";

/** Eligibility for this exact source, including historical pushed sample versions. No signing/writes. */
export function readSamplePlayableFacts(
  tx: Tx,
  input: {
    orderItemId: string;
    sourceFileId: string;
    entityId: string;
    storeId: string;
  },
) {
  return tx.sample.findFirst({
    where: {
      fileId: input.sourceFileId,
      entityId: input.entityId,
      storeId: input.storeId,
      pushedAt: { not: null },
      previewChannels: { has: "weapp" },
      deliveryTicket: {
        orderItemId: input.orderItemId,
        entityId: input.entityId,
        storeId: input.storeId,
      },
    },
    select: {
      id: true,
      fileId: true,
      deliveryTicketId: true,
      versionNo: true,
      status: true,
      pushedAt: true,
      previewChannels: true,
      updatedAt: true,
    },
    orderBy: [{ versionNo: "desc" }, { id: "desc" }],
  });
}
