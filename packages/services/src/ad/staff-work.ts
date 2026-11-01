import { AppError } from "../kernel/index.js";
import type { StaffWorkSource } from "../kernel/index.js";
import { staffBriefs } from "../staff/index.js";

const openStates = ["producing", "revising", "pending_confirm", "returned"];

/** ad owns both the current workload and the locked reassignment; staff owns the history. */
export const adStaffWork: StaffWorkSource = {
  async listOpen(tx, { staffId }) {
    const rows = await tx.ad.findMany({
      where: { editorId: staffId, status: { in: openStates } },
      select: { id: true, adNo: true, entityId: true, storeId: true },
      orderBy: { id: "asc" },
    });
    return rows.map((ad) => ({
      source: "ad_editor" as const,
      subjectType: "ad" as const,
      subjectId: ad.id,
      label: ad.adNo,
      entityId: ad.entityId,
      storeId: ad.storeId,
      reassignOwner: "ad" as const,
      locks: [
        { table: "store" as const, id: ad.storeId },
        { table: "ad" as const, id: ad.id },
      ],
    }));
  },
  async reassign(tx, input) {
    const [target] = await staffBriefs(tx, [input.toStaffId]);
    if (
      !target ||
      target.status !== "active" ||
      target.roleKey !== "editor" ||
      input.fromStaffId === input.toStaffId
    )
      throw new AppError("ASSIGNEE_INVALID");
    const moved = [];
    for (const item of input.items) {
      if (
        item.source !== "ad_editor" ||
        item.subjectType !== "ad" ||
        item.reassignOwner !== "ad" ||
        item.storeId === null
      )
        throw new AppError("PRECONDITION_CHANGED");
      const changed = await tx.ad.updateMany({
        where: {
          id: item.subjectId,
          entityId: item.entityId,
          storeId: item.storeId,
          editorId: input.fromStaffId,
          status: { in: openStates },
        },
        data: { editorId: input.toStaffId, lockVersion: { increment: 1 }, updatedAt: input.now },
      });
      if (changed.count) moved.push(item);
    }
    return moved;
  },
};
