import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

interface StoreScope {
  readonly entityId: string;
  readonly storeId: string;
}
/** 只读锁图计划；与已分配订单的改派分开，空负责人不伪造from/history或移交计数。 */
export async function readUnassignedStoreOrderIds(tx: Tx, scope: StoreScope): Promise<string[]> {
  return (
    await tx.dramaOrder.findMany({
      where: {
        entityId: scope.entityId,
        storeId: scope.storeId,
        deliveryManagerId: null,
        status: { notIn: ["ended", "cancelled", "refunded"] },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    })
  ).map((row) => row.id);
}
/** 调用者已按完整锁图锁本集合；新发现的对象必须整TX重试，不能补低阶锁。 */
export async function syncUnassignedStoreOrders(
  tx: Tx,
  input: StoreScope & {
    readonly ids: readonly string[];
    readonly staffId: string;
    readonly now: Date;
  },
): Promise<number> {
  const current = await readUnassignedStoreOrderIds(tx, input),
    planned = new Set(input.ids);
  if (current.some((id) => !planned.has(id))) throw new AppError("BUSY");
  await lockRows(tx, "drama_order", input.ids);
  const result = await tx.dramaOrder.updateMany({
    where: {
      id: { in: [...input.ids] },
      entityId: input.entityId,
      storeId: input.storeId,
      deliveryManagerId: null,
      status: { notIn: ["ended", "cancelled", "refunded"] },
    },
    data: { deliveryManagerId: input.staffId, updatedAt: input.now },
  });
  if (result.count !== input.ids.length) throw new AppError("BUSY");
  return result.count;
}
