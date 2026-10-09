import type { Prisma } from "@liyoxi/db";
import type { StaffWorkItem, StaffWorkSource } from "../kernel/index.js";
const open = { notIn: ["archived", "terminated"] };
export const deliveryStaffWork: StaffWorkSource = {
  async listOpen(tx, { staffId }) {
    const rows = await tx.deliveryTicket.findMany({
      where: {
        OR: [
          {
            step: open,
            OR: [{ deliveryManagerId: staffId }, { editorId: staffId }, { publisherId: staffId }],
          },
          {
            step: "terminated",
            takedownTasks: { some: { status: { notIn: ["checked", "void"] } } },
            OR: [{ editorId: staffId }, { publisherId: staffId }],
          },
        ],
      },
      select: {
        id: true,
        entityId: true,
        storeId: true,
        dramaOrderId: true,
        orderItemId: true,
        ticketNo: true,
        step: true,
        deliveryManagerId: true,
        editorId: true,
        publisherId: true,
      },
      orderBy: { id: "asc" },
    });
    const items: StaffWorkItem[] = [];
    for (const r of rows) {
      for (const [field, source] of [
        ["deliveryManagerId", "store_manager"],
        ["editorId", "ticket_editor"],
        ["publisherId", "ticket_publisher"],
      ] as const) {
        if (r[field] !== staffId || (r.step === "terminated" && source === "store_manager"))
          continue;
        items.push({
          source,
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
        });
      }
    }
    return items;
  },
  async reassign(tx, input) {
    const moved = [];
    for (const item of input.items) {
      const field =
        item.source === "store_manager"
          ? "deliveryManagerId"
          : item.source === "ticket_editor"
            ? "editorId"
            : "publisherId";
      const where: Prisma.DeliveryTicketWhereInput = {
        id: item.subjectId,
        [field]: input.fromStaffId,
        OR: [
          { step: open },
          {
            step: "terminated",
            takedownTasks: { some: { status: { notIn: ["checked", "void"] } } },
          },
        ],
      };
      const result = await tx.deliveryTicket.updateMany({
        where,
        data: { [field]: input.toStaffId, updatedAt: input.now },
      });
      if (result.count) moved.push(item);
    }
    return moved;
  },
};
