import type { Agreement, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { createPurchaseApi, type PurchaseType } from "../plan-pick/api";

export function createTopupApi(call: RequestLayer["request"]) {
  const purchase = createPurchaseApi(call);
  return {
    ...purchase,
    policy: (type: PurchaseType = "topup") => purchase.policy(type),
    wallet: () => call<Data<"m.wallet.get">>("/m/wallet"),
    packs: () => call<Data<"m.pointPack.list">>("/m/point-packs"),
    async agreements() {
      const items: Agreement[] = [];
      let cursor: string | null = null;
      do {
        const page: Data<"m.agreement.list"> = await call(
          `/m/agreements?scene=topup&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        items.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor);
      return items;
    },
  };
}
export type TopupApi = ReturnType<typeof createTopupApi>;
