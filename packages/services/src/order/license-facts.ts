import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface OrderLicenseFact {
  orderItemId: string;
  orderId: string;
  orderNo: string;
  itemNo: number;
  entityId: string;
  storeId: string;
  dramaId: string;
  phase: string;
  usageStartDate: string | null;
  usageEndDate: string;
  consentId: string;
  accounts: { channelAccountId: string; platform: string }[];
}

export interface LicenseCandidateItemsQuery {
  cursor?: string;
  limit: number;
  entityIds?: readonly string[];
}

const itemKeys = (ids: readonly string[]) => [...new Set(ids.map((id) => id.toLowerCase()))].sort();

/** 整批先锁父单160，再锁项170；调用方必须在任何信件240前完成此步骤。 */
export async function lockOrderLicenseItems(tx: Tx, ids: readonly string[]): Promise<void> {
  const keys = itemKeys(ids);
  if (keys.length === 0) return;
  // dramaOrderId 创建后不可变，预读只用于发现需要一起持有的父锁。
  const owners = await tx.orderItem.findMany({
    where: { id: { in: keys } },
    select: { id: true, dramaOrderId: true },
    orderBy: { id: "asc" },
  });
  const orderIds = [...new Set(owners.map((row) => row.dramaOrderId))].sort();
  const lockedOrders = await lockRows(tx, "drama_order", orderIds);
  const lockedItems = await lockRows(tx, "order_item", keys);
  if (
    owners.length !== keys.length ||
    lockedOrders.length !== orderIds.length ||
    lockedItems.length !== keys.length
  )
    throw new AppError("NOT_FOUND", { message: "授权事实所需的订单或订单项不存在" });
}

/** 只读取当前订单项与实际选定账号，不从工单步骤或事件载荷重新推导阶段。 */
export async function readOrderLicenseFacts(
  tx: Tx,
  ids: readonly string[],
): Promise<OrderLicenseFact[]> {
  const keys = itemKeys(ids);
  if (keys.length === 0) return [];
  const rows = await tx.orderItem.findMany({
    where: { id: { in: keys } },
    select: {
      id: true,
      dramaOrderId: true,
      itemNo: true,
      entityId: true,
      storeId: true,
      dramaId: true,
      phase: true,
      usageStartDate: true,
      usageEndDate: true,
      dramaOrder: { select: { orderNo: true, agreementConsentId: true } },
      orderItemAccounts: {
        select: { channelAccountId: true, platform: true },
        orderBy: { channelAccountId: "asc" },
      },
    },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => ({
    orderItemId: row.id,
    orderId: row.dramaOrderId,
    orderNo: row.dramaOrder.orderNo,
    itemNo: row.itemNo,
    entityId: row.entityId,
    storeId: row.storeId,
    dramaId: row.dramaId,
    phase: row.phase,
    usageStartDate: row.usageStartDate?.toISOString().slice(0, 10) ?? null,
    usageEndDate: row.usageEndDate.toISOString().slice(0, 10),
    consentId: row.dramaOrder.agreementConsentId,
    accounts: row.orderItemAccounts,
  }));
}

/** N6 从当前可授权项发现全部缺信的组合，按不可变 id 游标分批扫描。 */
export async function listLicenseCandidateItemIds(
  tx: Tx,
  input: LicenseCandidateItemsQuery,
): Promise<string[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1)
    throw new TypeError("授权事实候选页容量必须是正整数");
  const rows = await tx.orderItem.findMany({
    where: {
      phase: { in: ["producing", "to_launch", "live", "ended"] },
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      ...(input.entityIds ? { entityId: { in: [...input.entityIds] } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: input.limit,
  });
  return rows.map((row) => row.id);
}

/** 同单事件只提供重读信号，目标项始终从当前父单关系取得。 */
export async function readLicenseOrderItemIds(tx: Tx, orderId: string): Promise<string[]> {
  const rows = await tx.orderItem.findMany({
    where: { dramaOrderId: orderId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}
