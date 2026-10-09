import type { StaffWorkSource } from "../kernel/index.js";
/** 已终止工单的未核查下架责任仍由所属工单的发布专员承担。 */
export const publishStaffWork: StaffWorkSource = {
  async listOpen(tx, { staffId }) {
    const rows = await tx.deliveryTicket.findMany({
      where: {
        publisherId: staffId,
        step: "terminated",
        takedownTasks: { some: { status: { notIn: ["checked", "void"] } } },
      },
      select: {
        id: true,
        entityId: true,
        storeId: true,
        dramaOrderId: true,
        orderItemId: true,
        ticketNo: true,
      },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => ({
      source: "ticket_publisher",
      subjectType: "delivery_ticket",
      subjectId: r.id,
      label: r.ticketNo,
      entityId: r.entityId,
      storeId: r.storeId,
      reassignOwner: "delivery",
      locks: [
        { table: "store", id: r.storeId },
        { table: "drama_order", id: r.dramaOrderId },
        { table: "order_item", id: r.orderItemId },
        { table: "delivery_ticket", id: r.id },
      ],
    }));
  },
  async reassign() {
    throw new TypeError("派生发布责任必须经交付拥有者改派工单");
  },
};
