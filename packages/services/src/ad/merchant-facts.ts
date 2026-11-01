import type { MerchantFactsProvider } from "../kernel/index.js";
export const adMerchantFacts: MerchantFactsProvider<"ad"> = async (tx, query) => {
  const rows = await tx.ad.groupBy({
    by: ["storeId", "status"],
    where: { entityId: query.entityId, storeId: { in: [...query.storeIds] } },
    _count: true,
  });
  return {
    stores: Object.fromEntries(
      query.storeIds.map((id) => {
        const count = (statuses: readonly string[]) =>
          rows
            .filter((r) => r.storeId === id && statuses.includes(r.status))
            .reduce((n, r) => n + r._count, 0);
        return [
          id,
          {
            pendingConfirmCount: count(["pending_confirm"]),
            producingCount: count(["pending_assign", "producing", "returned"]),
            readyCount: count(["confirmed"]),
            revisingCount: count(["revising"]),
          },
        ];
      }),
    ),
  };
};
