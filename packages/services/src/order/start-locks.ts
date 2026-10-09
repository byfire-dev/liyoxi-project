import { getTicketBriefsByOrder, prepareTicketAssignees } from "../delivery/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { pickNext, prepareAssignmentPools } from "../staff/index.js";
import type { OrderStartBinding } from "./start-binding.js";

/** 两池与门店现有经理统一升序锁；锁后重核推荐，再调用真正的分配口重入已持锁。 */
export async function prepareStartStaff(
  tx: Tx,
  deps: OrderStartBinding,
  stores: readonly { id: string; deliveryManagerId: string | null; cityCode: string | null }[],
  orderId?: string,
) {
  await prepareAssignmentPools(
    tx,
    [
      ...stores
        .filter((s) => s.deliveryManagerId === null)
        .map((s) => ({ pool: "delivery_manager" as const, scopeKey: s.cityCode ?? "all" })),
      ...(orderId ? [{ pool: "publisher" as const, scopeKey: "all" }] : []),
    ],
    stores.flatMap((s) => (s.deliveryManagerId ? [s.deliveryManagerId] : [])),
  );
  const selected = new Map<string, string | null>();
  for (const store of stores) {
    if (store.deliveryManagerId) {
      const staff = await tx.staff.findUnique({ where: { id: store.deliveryManagerId } });
      if (!staff || staff.status !== "active" || staff.staffRoleKey !== "delivery_manager")
        throw new AppError("ASSIGNEE_INVALID", {
          details: { staffId: store.deliveryManagerId, reason: "not_active" },
        });
      selected.set(store.id, store.deliveryManagerId);
    } else {
      const picked = await pickNext(tx, "delivery_manager", store.cityCode ?? "all");
      selected.set(store.id, picked?.staffId ?? null);
    }
  }
  if (orderId) {
    await prepareTicketAssignees(tx, orderId);
  }
  return selected;
}

/** 首次指派会同步整个门店；先持全部父/项/工单，允许其真实端口按既有锁重入。 */
export async function lockManagerBusiness(tx: Tx, storeIds: readonly string[]) {
  await lockRows(tx, "store", storeIds);
  const orders = await tx.dramaOrder.findMany({
    where: {
      storeId: { in: [...storeIds] },
      status: { notIn: ["ended", "cancelled", "refunded"] },
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  await lockRows(
    tx,
    "drama_order",
    orders.map((o) => o.id),
  );
  const items = await tx.orderItem.findMany({
    where: { dramaOrderId: { in: orders.map((o) => o.id) } },
    select: { id: true },
  });
  await lockRows(
    tx,
    "order_item",
    items.map((i) => i.id),
  );
  const tickets = [];
  for (const order of orders) tickets.push(...(await getTicketBriefsByOrder(tx, order.id)));
  await lockRows(
    tx,
    "delivery_ticket",
    tickets.map((t) => t.deliveryTicketId),
  );
}
