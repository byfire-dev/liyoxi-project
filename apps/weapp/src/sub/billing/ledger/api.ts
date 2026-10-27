import type { operations } from "@liyoxi/contract/types/merchant";
import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type LedgerPage = Data<"m.pointLedgerEntry.list">;
export type LedgerRow = LedgerPage["items"][number];
export type LedgerQuery = NonNullable<operations["m.pointLedgerEntry.list"]["parameters"]["query"]>;
export type LedgerTab = NonNullable<LedgerQuery["tab"]>;

export function createLedgerApi(request: RequestLayer["request"]) {
  return {
    list(query: LedgerQuery) {
      const pairs = Object.entries({ ...query, limit: 20 })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
      return request<LedgerPage>(`/m/point-ledger-entries?${pairs.join("&")}`);
    },
  };
}
export type LedgerApi = ReturnType<typeof createLedgerApi>;
