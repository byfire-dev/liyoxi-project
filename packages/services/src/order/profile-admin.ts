import { DramaSnapshotSchema, StoreHeaderSchema } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";
import type { AdminFacts, AdminFactsQuery } from "../profile/index.js";
import { CLOSED_ORDERS } from "./counts.js";
const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;

/** 所有行同时限定主体与门店；仅经理在办量再限定实际负责人。 */
export async function readProfileAdminOrderFacts(
  tx: Tx,
  q: AdminFactsQuery,
): Promise<AdminFacts["order"]> {
  const where = { entityId: q.entityId, storeId: q.storeId };
  const latest = await tx.dramaOrder.aggregate({ where, _max: { submittedAt: true } });
  const live = { ...where, phase: "live" };
  const summary = await tx.orderItem.aggregate({
    where: live,
    _count: true,
    _min: { usageStartDate: true },
  });
  const lastLive = await tx.orderItem.findFirst({
    where: live,
    orderBy: [{ usageEndDate: "desc" }, { id: "asc" }],
    select: { usageEndDate: true, usageEndSource: true },
  });
  const agreed = await tx.orderItem.aggregate({
    where: { ...where, phase: { in: ["producing", "to_launch"] } },
    _min: { agreedLaunchDate: true },
  });
  const pending = await tx.dramaOrder.findMany({
    where: { ...where, status: "pending_start" },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      orderNo: true,
      itemCount: true,
      totalChargePoints: true,
      orderItems: { where: { itemNo: 1 }, select: { dramaSnapshot: true } },
    },
  });
  return {
    lastOrderAt: latest._max.submittedAt?.toISOString() ?? null,
    dramaOrderCount:
      q.managerId === null
        ? 0
        : await tx.dramaOrder.count({
            where: { ...where, deliveryManagerId: q.managerId, status: { notIn: CLOSED_ORDERS } },
          }),
    liveDramaCount: summary._count,
    liveSummary: StoreHeaderSchema.shape.liveSummary.parse({
      firstLiveDate: date(summary._min.usageStartDate),
      latestUsageEndDate: date(lastLive?.usageEndDate ?? null),
      usageEndSource: lastLive?.usageEndSource ?? null,
    }),
    nearestAgreedLaunchDate: date(agreed._min.agreedLaunchDate),
    relatedOrders: pending.map((r) => ({
      kind: "drama_order" as const,
      id: r.id,
      no: r.orderNo,
      title: `《${DramaSnapshotSchema.parse(r.orderItems[0]?.dramaSnapshot).title}》${r.itemCount > 1 ? `等 ${r.itemCount} 部` : ""}`,
      statusText: "待开工",
      amountFen: null,
      heldPoints: r.totalChargePoints,
    })),
  };
}
