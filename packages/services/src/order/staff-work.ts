import type { StaffWorkSource } from "../kernel/index.js";
const open = { notIn: ["ended", "cancelled", "refunded"] };
export const orderStaffWork: StaffWorkSource = {
  async listOpen(tx, { staffId }) {
    const rows = await tx.dramaOrder.findMany({
      where: { deliveryManagerId: staffId, status: open },
      select: { id: true, entityId: true, storeId: true, orderNo: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => ({
      source: "store_manager",
      subjectType: "drama_order",
      subjectId: r.id,
      label: r.orderNo,
      entityId: r.entityId,
      storeId: r.storeId,
      reassignOwner: "order",
      locks: [
        { table: "store", id: r.storeId },
        { table: "drama_order", id: r.id },
      ],
    }));
  },
  async reassign(tx, input) {
    const moved = [];
    for (const item of input.items) {
      const result = await tx.dramaOrder.updateMany({
        where: { id: item.subjectId, deliveryManagerId: input.fromStaffId, status: open },
        data: { deliveryManagerId: input.toStaffId, updatedAt: input.now },
      });
      if (result.count) moved.push(item);
    }
    return moved;
  },
};
