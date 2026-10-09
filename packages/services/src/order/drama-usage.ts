import { calendarDate, addDays, dayRange } from "@liyoxi/shared/time";
import type { DramaUsage } from "../content/index.js";

/** Counts order items, rather than orders, because each purchased drama is one item. */
export const dramaUsage: DramaUsage = {
  async stats(tx, ids, at) {
    const today = calendarDate(at);
    const since30d = dayRange(addDays(today, -29)).start;
    const month = dayRange(today.slice(0, 7) + "-01").start;
    const base = { dramaId: { in: [...ids] }, phase: { notIn: ["cancelled", "refunded"] } };
    const [recent, mtd, live] = await Promise.all([
      tx.orderItem.groupBy({
        by: ["dramaId"],
        where: { ...base, dramaOrder: { submittedAt: { gte: since30d, lte: at } } },
        _count: true,
      }),
      tx.orderItem.groupBy({
        by: ["dramaId"],
        where: { ...base, dramaOrder: { submittedAt: { gte: month, lte: at } } },
        _count: true,
      }),
      tx.orderItem.groupBy({
        by: ["dramaId"],
        where: { dramaId: { in: [...ids] }, phase: "live" },
        _count: true,
      }),
    ]);
    const result = new Map(ids.map((id) => [id, { orders30d: 0, ordersMtd: 0, liveItems: 0 }]));
    for (const [rows, field] of [
      [recent, "orders30d"],
      [mtd, "ordersMtd"],
      [live, "liveItems"],
    ] as const)
      for (const row of rows) result.get(row.dramaId)![field] = row._count;
    return result;
  },
  async hasOpenItems(tx, dramaId) {
    return (
      (await tx.orderItem.count({
        where: { dramaId, phase: { notIn: ["ended", "cancelled", "refunded", "terminated"] } },
      })) > 0
    );
  },
};
