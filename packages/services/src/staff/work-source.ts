import type { StaffWorkSource } from "../kernel/index.js";
export const staffFollowUpWork: StaffWorkSource = {
  async listOpen(tx, { staffId }) {
    const rows = await tx.followUp.findMany({
      where: { ownerStaffId: staffId, nextFollowAt: { not: null }, doneAt: null },
      select: { id: true, entityId: true, storeId: true, content: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => ({
      source: "follow_up_owner",
      subjectType: "follow_up",
      subjectId: r.id,
      label: r.content,
      entityId: r.entityId,
      storeId: r.storeId,
      reassignOwner: "staff",
      locks: [],
    }));
  },
  async reassign(tx, input) {
    const moved = [];
    for (const item of input.items) {
      const result = await tx.followUp.updateMany({
        where: {
          id: item.subjectId,
          ownerStaffId: input.fromStaffId,
          nextFollowAt: { not: null },
          doneAt: null,
        },
        data: {
          ownerStaffId: input.toStaffId,
          lockVersion: { increment: 1 },
          updatedAt: input.now,
        },
      });
      if (result.count) moved.push(item);
    }
    return moved;
  },
};
