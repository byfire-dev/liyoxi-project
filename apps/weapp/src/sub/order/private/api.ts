import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
import type { OrderTab } from "@/stores/order";
let offline: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_ORDER_SHOT__?: string }).__LYX_ORDER_SHOT__;
    if (scene) {
      offline ??= (await import("../../../../shots/order-fixtures")).offlineOrderRequest(scene);
      return offline(path, options);
    }
  }
  return request(path, options);
};
export function createOrderApi(send: RequestLayer["request"]) {
  return {
    quote: (data: Body<"m.order.quote">) =>
      send<Data<"m.order.quote">>("/m/orders/quote", { method: "POST", data }),
    create: (data: Body<"m.order.create">, idempotencyKey: string) =>
      send<Data<"m.order.create">>("/m/orders", { method: "POST", data, idempotencyKey }),
    list: (tab: OrderTab, cursor?: string) =>
      send<Data<"m.order.list">>(
        `/m/orders?tab=${tab}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    detail: (id: string) => send<Data<"m.order.get">>(`/m/orders/${encodeURIComponent(id)}`),
    item: (id: string) => send<Data<"m.orderItem.get">>(`/m/order-items/${encodeURIComponent(id)}`),
    accounts: async () => {
      const items: Data<"m.channelAccount.list">["items"] = [],
        cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await send<Data<"m.channelAccount.list">>(
          `/m/channel-accounts?status=available&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        items.push(...page.items);
        if (!page.hasMore || !page.nextCursor) break;
        if (cursors.has(page.nextCursor)) throw new Error("账号分页游标重复，请刷新重试");
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      const seen = new Set<string>();
      return {
        items: items.filter(
          (i) => !seen.has(i.channelAccountId) && Boolean(seen.add(i.channelAccountId)),
        ),
        hasMore: false,
        nextCursor: null,
      };
    },
    focus: () => send<Data<"m.dictItem.list">>("/m/dict-items?typeKey=custom_focus"),
    policy: () => send<Data<"m.purchasePolicy.get">>("/m/purchase-policy"),
    cart: () => send<Data<"m.cartItem.list">>("/m/cart-items"),
  };
}
export const orderApi = createOrderApi(call);
