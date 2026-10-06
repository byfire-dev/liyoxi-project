import { definePort } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";

export interface ManagerAssignment {
  readonly storeId: string;
  readonly entityId: string;
  readonly staffId: string;
  readonly ctx: IdentityContext;
}
export type SyncStoreManager = (tx: Tx, input: ManagerAssignment) => Promise<void>;
// W1-15 / W1-16a 各自注册；两个写入与 tenant 的门店更新共用同一事务。
export const orderManagerPort = definePort<SyncStoreManager>("profile.order_manager_sync", {
  fallback: async () => {},
});
export const deliveryManagerPort = definePort<SyncStoreManager>("profile.delivery_manager_assign", {
  fallback: async () => {},
});
