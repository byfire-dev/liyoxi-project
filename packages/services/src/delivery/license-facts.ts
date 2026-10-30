import { AppError } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import type { LicenseFactPort, LicenseFacts } from "../docs/index.js";

interface ItemFact extends Omit<LicenseFacts, "accounts"> {
  readonly accounts: readonly { channelAccountId: string; platform: string }[];
}
interface AccountFact {
  readonly id: string;
  readonly entityId: string;
  readonly storeId: string;
  readonly platform: string;
  readonly name: string;
  readonly accountNo: string;
}
export function createLicenseFacts(deps: {
  lockItems(tx: Tx, ids: readonly string[]): Promise<void>;
  readItems(tx: Tx, ids: readonly string[]): Promise<readonly ItemFact[]>;
  readAccounts(tx: Tx, ids: readonly string[]): Promise<readonly AccountFact[]>;
  listCandidateIds: LicenseFactPort["listCandidateIds"];
  orderItemIds: LicenseFactPort["orderItemIds"];
}): LicenseFactPort {
  const readLicenseFacts: LicenseFactPort["readLicenseFacts"] = async (tx, ids) => {
    const items = await deps.readItems(tx, ids);
    const accounts = await deps.readAccounts(
      tx,
      items.flatMap((item) => item.accounts.map((a) => a.channelAccountId)),
    );
    return items.map((item) => ({
      ...item,
      accounts: item.accounts.map((selected) => {
        const row = accounts.find((a) => a.id === selected.channelAccountId);
        if (
          !row ||
          row.entityId !== item.entityId ||
          row.storeId !== item.storeId ||
          row.platform !== selected.platform
        )
          throw new AppError("INTERNAL", { message: "授权账号事实缺失或归属不一致" });
        return {
          channelAccountId: row.id,
          platform: row.platform,
          name: row.name,
          accountNo: row.accountNo,
        };
      }),
    }));
  };
  return {
    readLicenseFacts,
    async getLicenseFacts(tx, ids) {
      await deps.lockItems(tx, ids);
      return readLicenseFacts(tx, ids);
    },
    listCandidateIds: deps.listCandidateIds,
    orderItemIds: deps.orderItemIds,
    eventItemIds: (tx, event) => licenseEventItemIds(tx, event, deps.orderItemIds),
    async readReferences(tx, input) {
      const items = await deps.readItems(tx, input.itemIds);
      const accounts = await deps.readAccounts(tx, input.accountIds);
      return { items, accounts };
    },
  };
}

/** Old events are signals only. Resolve missing ticket/plan targets through their owning domain. */
async function licenseEventItemIds(
  tx: Tx,
  event: DeliveredEvent,
  orderItems: LicenseFactPort["orderItemIds"],
): Promise<readonly string[]> {
  const payload = event.payload;
  if (typeof payload.dramaOrderId === "string") {
    const ids = await orderItems(tx, payload.dramaOrderId);
    if (!ids.length) throw new AppError("NOT_FOUND", { message: "授权事实信号对应的订单项不存在" });
    return ids;
  }
  if (typeof payload.orderItemId === "string") return [payload.orderItemId];
  if (
    Array.isArray(payload.orderItemIds) &&
    payload.orderItemIds.every((id) => typeof id === "string")
  ) {
    if (!payload.orderItemIds.length) throw new AppError("PRECONDITION_CHANGED");
    return payload.orderItemIds as string[];
  }
  if (typeof payload.deliveryTicketId === "string") {
    const ticket = await tx.deliveryTicket.findUnique({
      where: { id: payload.deliveryTicketId },
      select: { orderItemId: true },
    });
    if (ticket) return [ticket.orderItemId];
  }
  if (typeof payload.deliveryPlanId === "string") {
    const plan = await tx.deliveryPlan.findUnique({
      where: { id: payload.deliveryPlanId },
      select: { dramaOrderId: true },
    });
    if (plan) {
      const ids = await orderItems(tx, plan.dramaOrderId);
      if (ids.length) return ids;
    }
  }
  throw new AppError("PRECONDITION_CHANGED", { message: "授权事实信号缺少可核实的当前目标" });
}
