import type { StoreRow } from "@liyoxi/contract";
import { definePort } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface StoreListBillingFact {
  readonly status: "none" | "active" | "expired";
  readonly activePlanId: string | null;
  readonly remainingDays: number | null;
  readonly totalPaidFen: number;
  readonly hasPaidOrder: boolean;
}
export interface StoreListBillingSelection {
  readonly facts: ReadonlyMap<string, StoreListBillingFact>;
  /** 仅在本次调用方事务里投影候选集的分页子集；各主体权益只取一次。 */
  readRows(
    tx: Tx,
    entityIds: readonly string[],
  ): Promise<ReadonlyMap<string, Pick<StoreRow, "subscription" | "points">>>;
}
export const adminStoreListBillingPort = definePort<
  (
    tx: Tx,
    input: { readonly entityIds: readonly string[]; readonly now: Date },
  ) => Promise<StoreListBillingSelection>
>("profile.store_list_billing");
export const adminStoreListOrderPort = definePort<
  (tx: Tx, storeIds: readonly string[]) => Promise<ReadonlyMap<string, Date | null>>
>("profile.store_list_order");
