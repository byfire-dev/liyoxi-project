import { visible } from "@liyoxi/shared/catalog";
import { calendarDate } from "@liyoxi/shared/time";
import { paramsAt, priceAt } from "../billing/index.js";
import type { Tx, MerchantFactsProvider } from "../kernel/index.js";
/** 已取消、结束和退款的订购单仍是门店业务历史。 */
export function countStoreOrderHistory(tx: Tx, input: { entityId: string; storeId: string }) {
  return tx.dramaOrder.count({ where: input });
}
export const ITEM_GROUPS = [
  ["live"],
  ["pending_start", "producing", "to_launch"],
  ["ended", "refunded", "terminated"],
] as const;
export const CLOSED_ORDERS = ["ended", "cancelled", "refunded"];
export async function countOpenOrdersByEntity(tx: Tx, entityId: string) {
  return tx.dramaOrder.count({ where: { entityId, status: { notIn: CLOSED_ORDERS } } });
}
// 当前 tenant 尚无 StoreCloseGuard 端口；公开准确计数供后继接线，不虚造已注册的停用守卫。
export async function countBlockingStoreOrders(tx: Tx, storeId: string) {
  return tx.dramaOrder.count({
    where: { storeId, status: { in: ["pending_start", "producing", "to_launch", "after_sale"] } },
  });
}
export async function countOrderItemsByPhase(tx: Tx, storeId: string, orderId?: string) {
  const grouped = await tx.orderItem.groupBy({
    by: ["phase"],
    where: { storeId, ...(orderId ? { dramaOrderId: orderId } : {}) },
    _count: true,
  });
  const count = (phases: readonly string[]) =>
    grouped.filter((r) => phases.includes(r.phase)).reduce((n, r) => n + r._count, 0);
  return {
    all: count(ITEM_GROUPS.flat()),
    live: count(ITEM_GROUPS[0]),
    to_launch: count(ITEM_GROUPS[1]),
    ended: count(ITEM_GROUPS[2]),
    delivering: count(["producing", "to_launch"]),
  };
}
export async function countCartBadge(tx: Tx, storeId: string, at: Date) {
  const rows = await tx.cartItem.findMany({
    where: { storeId },
    include: { drama: { include: { dramaCopyrights: true } } },
  });
  if (rows.length === 0) return 0;
  const params = await paramsAt(tx, at),
    prices = await priceAt(
      tx,
      rows.map((r) => r.dramaId),
      at,
    );
  return rows.filter(
    (r) =>
      typeof prices.get(r.dramaId) === "object" &&
      visible(
        {
          status: r.drama.status,
          archivedAt: r.drama.archivedAt,
          licenseEndDate:
            r.drama.dramaCopyrights[0]?.licenseEndDate?.toISOString().slice(0, 10) ?? null,
          minLicenseMonths: params.minLicenseMonths,
        },
        calendarDate(at),
      ),
  ).length;
}
export const orderMerchantFacts: MerchantFactsProvider<"order"> = async (tx, query) => {
  const stores: Record<
    string,
    { liveCount: number; deliveringCount: number; cartCount: number; todoCount: number }
  > = {};
  for (const storeId of query.storeIds) {
    const store = await tx.store.findUnique({ where: { id: storeId }, select: { entityId: true } });
    if (store?.entityId !== query.entityId) throw new TypeError("order 事实查询的门店不属于主体");
    const counts = await countOrderItemsByPhase(tx, storeId);
    stores[storeId] = {
      liveCount: counts.live,
      deliveringCount: counts.delivering,
      cartCount: await countCartBadge(tx, storeId, query.now),
      todoCount: 0,
    };
  }
  return { stores };
};
