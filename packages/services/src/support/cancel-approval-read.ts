import type { Tx } from "../kernel/index.js";

/** 已经按取消申请鉴权后，只读同主体、同门店的实际客服引用。 */
export async function readCancelApprovalRefs(
  tx: Tx,
  input: {
    readonly approvalRequestId: string;
    readonly entityId: string;
    readonly storeId: string;
  },
) {
  const rows = await tx.serviceTicketRef.findMany({
    where: {
      refType: "approval_request",
      refId: input.approvalRequestId,
      serviceTicket: { entityId: input.entityId, storeId: input.storeId },
    },
    include: { serviceTicket: { select: { id: true, ticketNo: true, status: true } } },
    orderBy: [{ createdAt: "asc" }, { serviceTicketId: "asc" }],
  });
  return rows.map(({ serviceTicket: row }) => ({
    serviceTicketId: row.id,
    ticketNo: row.ticketNo,
    status: row.status,
  }));
}
