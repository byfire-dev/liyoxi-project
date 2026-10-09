import type { StaffWorkSource } from "../kernel/index.js";

export const profileStaffWork: StaffWorkSource = {
  async listOpen(tx, { staffId }) {
    const rows = await tx.store.findMany({
      where: { deliveryManagerId: staffId },
      select: { id: true, entityId: true, name: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => ({
      source: "store_manager",
      subjectType: "store",
      subjectId: r.id,
      label: r.name ?? r.id,
      entityId: r.entityId,
      storeId: r.id,
      reassignOwner: "profile",
      locks: [{ table: "store", id: r.id }],
    }));
  },
  async reassign(tx, input) {
    const moved = [];
    for (const item of input.items) {
      const result = await tx.store.updateMany({
        where: { id: item.subjectId, deliveryManagerId: input.fromStaffId },
        data: { deliveryManagerId: input.toStaffId, updatedAt: input.now },
      });
      if (result.count) moved.push(item);
    }
    return moved;
  },
};
