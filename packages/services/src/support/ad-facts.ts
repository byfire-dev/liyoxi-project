import type { Tx } from "../kernel/index.js";

/** Exact store-scoped association; no ticket entry, phone or private attachment escapes this projection. */
export async function readAdServiceTickets(
  tx: Tx,
  input: { entityId: string; storeId: string; adId: string },
) {
  const rows = await tx.serviceTicket.findMany({
    where: {
      entityId: input.entityId,
      storeId: input.storeId,
      serviceTicketRefs: { some: { refType: "ad", refId: input.adId } },
    },
    select: { id: true, ticketNo: true, status: true, typeCode: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const types = await tx.dictItem.findMany({
    where: { dictTypeKey: "ticket_type", code: { in: rows.map((row) => row.typeCode) } },
    select: { code: true, name: true },
  });
  return rows.map((row) => ({
    serviceTicketId: row.id,
    ticketNo: row.ticketNo,
    status: row.status,
    type: {
      code: row.typeCode,
      name: types.find((item) => item.code === row.typeCode)?.name ?? row.typeCode,
    },
    createdAt: row.createdAt.toISOString(),
  }));
}
