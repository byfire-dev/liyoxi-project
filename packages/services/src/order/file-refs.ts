import { AppError, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, FileRefType, Tx } from "../kernel/index.js";
import { boundOrder } from "./binding.js";
import type { OrderBinding } from "./binding.js";

const closedStatuses = ["ended", "cancelled", "refunded"];

/** 订单拥有参考关系的生命周期；文件分类、归属和实际留存写入仍由media负责。 */
export const orderReferenceFileType: FileRefType = {
  roles: {
    reference: {
      categories: ["store_asset", "profile_image", "profile_video", "profile_promo"],
      retentionDays: 90,
      canRelease: async (tx, id) =>
        (await tx.dramaOrder.count({
          where: { id, status: { in: closedStatuses }, closedAt: { not: null } },
        })) === 1,
    },
  },
  // reference没有业务数组列；已有素材usage可独立保护尚未结束订单，含软删除素材。
  inUse: async (tx, fileId) => {
    const usages = await tx.storeAssetUsage.findMany({
      where: {
        usedByType: "drama_order",
        role: "reference",
        storeAsset: { storeAssetFiles: { some: { fileId } } },
      },
      select: { usedById: true },
    });
    const orders = await tx.dramaOrder.findMany({
      where: {
        id: { in: usages.map((usage) => usage.usedById) },
        status: { notIn: closedStatuses },
      },
      select: { id: true },
    });
    return orders.map((order) => ({ fileId, refId: order.id, role: "reference" }));
  },
};

/** 出站消费自有短事务：不扩取消财务锁图，也不依赖可能被抑制的父单状态事件。 */
export async function releaseClosedOrderReferences(
  tx: Tx,
  deps: Pick<OrderBinding, "media">,
  event: DeliveredEvent,
): Promise<void> {
  let orderIds: string[];
  if (event.type === "order.status_changed" && typeof event.payload.dramaOrderId === "string") {
    orderIds = [event.payload.dramaOrderId];
  } else if (
    event.type === "cancel.executed" &&
    typeof event.payload.cancelRequestId === "string"
  ) {
    const request = await tx.cancelRequest.findFirst({
      where: { id: event.payload.cancelRequestId, status: "done" },
      select: {
        dramaOrderId: true,
        cancelRequestLines: { where: { targetType: "order_item" }, select: { targetId: true } },
      },
    });
    if (!request) return;
    const items = await tx.orderItem.findMany({
      where: { id: { in: request.cancelRequestLines.map((line) => line.targetId) } },
      select: { dramaOrderId: true },
    });
    orderIds = [
      ...new Set([
        ...(request.dramaOrderId ? [request.dramaOrderId] : []),
        ...items.map((item) => item.dramaOrderId),
      ]),
    ];
  } else return;
  await lockRows(tx, "drama_order", orderIds);
  const orders = await tx.dramaOrder.findMany({
    where: { id: { in: orderIds }, status: { in: closedStatuses }, closedAt: { not: null } },
    select: { id: true, entityId: true, storeId: true, closedAt: true },
  });
  const query = {
    refType: "drama_order",
    refId: { in: orders.map((order) => order.id) },
    role: "reference",
    state: "live",
  };
  const refs = await tx.fileRef.findMany({ where: query, orderBy: { fileId: "asc" } });
  if (!refs.length) return;
  if (!deps.media) throw new AppError("INTERNAL", { message: "订单参考文件释放尚未绑定媒体公口" });
  await lockRows(
    tx,
    "file_object",
    refs.map((ref) => ref.fileId),
  );
  // 父锁阻止合法引用生产/终态变化；文件锁后仍只处理当前live，跨事件重放零业务写。
  const current = await tx.fileRef.findMany({ where: query, orderBy: { fileId: "asc" } });
  if (current.some((ref) => !refs.some((known) => known.id === ref.id)))
    throw new AppError("PRECONDITION_CHANGED");
  for (const ref of current) {
    const order = orders.find((row) => row.id === ref.refId)!;
    const input = {
      fileId: ref.fileId,
      refType: ref.refType,
      refId: ref.refId,
      role: ref.role,
      entityId: order.entityId,
      storeId: order.storeId,
    };
    const fact = await deps.media.readRefRetention(tx, input);
    if (fact?.state !== "live") continue;
    await deps.media.release(tx, {
      ...input,
      keepUntil: new Date(order.closedAt!.getTime() + 90 * 86_400_000),
    });
  }
}

export const handleOrderReferencesClosed = (tx: Tx, event: DeliveredEvent) =>
  releaseClosedOrderReferences(tx, boundOrder(), event);
