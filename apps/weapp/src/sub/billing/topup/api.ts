import type { Agreement, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { createPurchaseApi } from "../plan-pick/api";

export function createTopupApi(call: RequestLayer["request"]) {
  return {
    ...createPurchaseApi(call),
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
