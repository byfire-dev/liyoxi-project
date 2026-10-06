import type { StoreHeader, StoreRow, QualificationSubmissionDetail } from "@liyoxi/contract";
import { defineKeyedPort, implementKeyed } from "../kernel/index.js";
import type { Assembly, Tx, PortImplementation } from "../kernel/index.js";
export interface AdminFactsQuery {
  readonly entityId: string;
  readonly storeId: string;
  readonly managerId: string | null;
  readonly ownerId: string | null;
  readonly now: Date;
}
export interface AdminFacts {
  billing: Pick<StoreHeader, "subscription" | "points" | "paid" | "pendingPointAdjustment"> & {
    relatedOrders: QualificationSubmissionDetail["relatedOrders"];
  };
  order: Pick<StoreHeader, "liveDramaCount" | "liveSummary" | "nearestAgreedLaunchDate"> & {
    lastOrderAt: StoreRow["lastOrderAt"];
    dramaOrderCount: number;
    relatedOrders: QualificationSubmissionDetail["relatedOrders"];
  };
  delivery: Pick<StoreHeader, "deliveringTicketCount"> & {
    producingCount: number;
    inServiceCount: number;
  };
  support: { serviceTicketCount: number };
  staff: Pick<StoreHeader, "isWecomAdded" | "managerContact">;
}
export type AdminFactSource = keyof AdminFacts;
type Provider = (tx: Tx, query: AdminFactsQuery) => Promise<AdminFacts[AdminFactSource]>;
/** 每个拥有者只返回自己的键；不读其他层的表、不写库、不调用 Provider。 */
export const adminProfileFactsPort = defineKeyedPort<Provider>("profile.admin_facts");
export function implementAdminProfileFacts<K extends AdminFactSource>(
  source: K,
  provider: (tx: Tx, query: AdminFactsQuery) => Promise<AdminFacts[K]>,
): PortImplementation {
  return implementKeyed(adminProfileFactsPort, source, provider);
}
export async function adminFactsOf(
  assembly: Assembly,
  tx: Tx,
  query: AdminFactsQuery,
): Promise<AdminFacts> {
  const defaults: AdminFacts = {
    billing: {
      subscription: {
        status: "none",
        plan: null,
        months: null,
        startDate: null,
        endDate: null,
        hasScheduledTerm: false,
        isRefundPending: false,
        latestPaymentOrder: null,
      },
      points: {
        spendablePoints: 0,
        planAvailablePoints: 0,
        addonAvailablePoints: 0,
        heldPoints: 0,
        isAddonSuspended: false,
      },
      paid: { totalPaidFen: 0, paidOrderCount: 0, planOrderCount: 0, topupOrderCount: 0 },
      pendingPointAdjustment: null,
      relatedOrders: [],
    },
    order: {
      lastOrderAt: null,
      dramaOrderCount: 0,
      relatedOrders: [],
      liveDramaCount: 0,
      liveSummary: { firstLiveDate: null, latestUsageEndDate: null, usageEndSource: null },
      nearestAgreedLaunchDate: null,
    },
    delivery: {
      deliveringTicketCount: 0,
      producingCount: 0,
      inServiceCount: 0,
    },
    support: { serviceTicketCount: 0 },
    staff: { isWecomAdded: false, managerContact: null },
  };
  const providers = assembly.portEntries(adminProfileFactsPort);
  for (const source of Object.keys(defaults) as AdminFactSource[]) {
    const provider = providers.get(source);
    if (provider) Object.assign(defaults, { [source]: await provider(tx, query) });
  }
  return defaults;
}
