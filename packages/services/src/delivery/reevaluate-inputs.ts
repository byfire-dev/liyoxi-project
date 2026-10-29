import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** Lock the low-ranked facts before a delivery writer takes its parent/production locks. */
export async function lockReevaluationInputs(
  tx: Tx,
  ticketIds: readonly string[],
  extraAdIds: readonly string[] = [],
) {
  const read = () =>
    tx.deliveryTicket.findMany({
      where: { id: { in: [...ticketIds] } },
      select: {
        id: true,
        dramaId: true,
        orderItem: { select: { orderItemPlacements: { select: { adId: true } } } },
      },
      orderBy: { id: "asc" },
    });
  const first = await read();
  const adIds = new Set([
    ...extraAdIds,
    ...first.flatMap((t) => t.orderItem.orderItemPlacements.map((p) => p.adId)),
  ]);
  await lockRows(
    tx,
    "drama",
    first.map((t) => t.dramaId),
    "share",
  );
  await lockRows(tx, "ad", [...adIds], "share");
  return async (currentAdIds: readonly string[] = []) => {
    const fresh = await read();
    if (
      JSON.stringify(fresh) !== JSON.stringify(first) ||
      currentAdIds.some((id) => !adIds.has(id))
    )
      throw new AppError("PRECONDITION_CHANGED", {
        message: "求值广告事实锁图变化，请重试整个事务",
      });
  };
}
