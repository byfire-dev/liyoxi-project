import type { operations } from "@liyoxi/contract/types/merchant";
import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type DramaQuery = NonNullable<operations["m.orderItem.list"]["parameters"]["query"]>;
export type DramaTab = NonNullable<DramaQuery["tab"]>;
export type DramaPage = Data<"m.orderItem.list">;
export type DramaSummary = Data<"m.orderItem.summary">;
export function createMyDramasApi(send: RequestLayer["request"]) {
  return {
    list: (tab: DramaTab, cursor?: string) =>
      send<DramaPage>(
        `/m/order-items?tab=${tab}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    summary: () => send<DramaSummary>("/m/order-items/summary"),
    get: (id: string) => send<Data<"m.orderItem.get">>(`/m/order-items/${encodeURIComponent(id)}`),
  };
}
