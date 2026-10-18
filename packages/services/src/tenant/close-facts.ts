import { definePort } from "../kernel/index.js";
import type { Assembly, Tx } from "../kernel/index.js";

type CountByStore = (tx: Tx, storeId: string) => Promise<number>;
type CountByEntity = (tx: Tx, entityId: string) => Promise<number>;

export interface BillingCloseCounts {
  readonly subscription_active: number;
  readonly payment_open: number;
  readonly refund_open: number;
  readonly invoice_open: number;
}
export interface StoreCloseCounts {
  readonly open_order: number;
  readonly open_delivery_ticket: number;
  readonly ad_in_production: number;
  readonly qualification_in_review: number;
  readonly channel_account_in_review: number;
  readonly unverified_primary_store: number;
}
export interface EntityDeletionCounts extends BillingCloseCounts {
  readonly open_order: number;
  readonly release_online: number;
}

// m02/m03/m05/m06/m07：固定所属域各实现自己的真实计数，全部为必需端口，无默认零。
export const billingCloseFactsPort = definePort<{
  deletionGuard(tx: Tx, entityId: string): Promise<BillingCloseCounts>;
}>("tenant.close_facts.billing");
export const orderCloseFactsPort = definePort<{
  countOpenOrdersByEntity: CountByEntity;
  countBlockingStoreOrders: CountByStore;
}>("tenant.close_facts.order");
export const deliveryCloseFactsPort = definePort<{
  countOnlineReleaseTicketsByEntity: CountByEntity;
  countBlockingStoreTickets: CountByStore;
}>("tenant.close_facts.delivery");
export const publishCloseFactsPort = definePort<{
  countPendingChannelAccountsByStore: CountByStore;
}>("tenant.close_facts.publish");
export const profileCloseFactsPort = definePort<{
  countQualificationSubmissionsInReview: CountByStore;
  countUnverifiedPrimaryStore: CountByStore;
}>("tenant.close_facts.profile");
export const adCloseFactsPort = definePort<{
  countBlockingStoreAds: CountByStore;
}>("tenant.close_facts.ad");

export const CLOSE_FACTS_PORTS = [
  billingCloseFactsPort,
  orderCloseFactsPort,
  deliveryCloseFactsPort,
  publishCloseFactsPort,
  profileCloseFactsPort,
  adCloseFactsPort,
] as const;

/** 调用方持主体/门店锁；不另开事务、不读上层表，所属来源失败直接传播。 */
export async function readStoreCloseCounts(
  tx: Tx,
  assembly: Pick<Assembly, "port">,
  storeId: string,
): Promise<StoreCloseCounts> {
  return {
    open_order: await assembly.port(orderCloseFactsPort).countBlockingStoreOrders(tx, storeId),
    open_delivery_ticket: await assembly
      .port(deliveryCloseFactsPort)
      .countBlockingStoreTickets(tx, storeId),
    ad_in_production: await assembly.port(adCloseFactsPort).countBlockingStoreAds(tx, storeId),
    qualification_in_review: await assembly
      .port(profileCloseFactsPort)
      .countQualificationSubmissionsInReview(tx, storeId),
    channel_account_in_review: await assembly
      .port(publishCloseFactsPort)
      .countPendingChannelAccountsByStore(tx, storeId),
    unverified_primary_store: await assembly
      .port(profileCloseFactsPort)
      .countUnverifiedPrimaryStore(tx, storeId),
  };
}

/** m01注销与a03关闭共用六类事实，复用调用方事务；生命周期写侧由主包消费。 */
export async function readEntityDeletionCounts(
  tx: Tx,
  assembly: Assembly,
  entityId: string,
): Promise<EntityDeletionCounts> {
  return {
    ...(await assembly.port(billingCloseFactsPort).deletionGuard(tx, entityId)),
    open_order: await assembly.port(orderCloseFactsPort).countOpenOrdersByEntity(tx, entityId),
    release_online: await assembly
      .port(deliveryCloseFactsPort)
      .countOnlineReleaseTicketsByEntity(tx, entityId),
  };
}
