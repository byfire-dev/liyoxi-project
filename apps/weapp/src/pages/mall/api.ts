import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
import type { DramaQuery } from "@/stores/catalog";
let sceneCall: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_CATALOG_SHOT__?: string }).__LYX_CATALOG_SHOT__;
    if (scene) {
      sceneCall ??= (await import("../../../shots/catalog-fixtures")).offlineCatalogRequest(scene);
      return sceneCall(path, options);
    }
  }
  return request(path, options);
};
export function createCatalogApi(send: RequestLayer["request"]) {
  return {
    home: () => send<Data<"m.home.get">>("/m/home"),
    config: () => send<Data<"m.mallConfig.get">>("/m/mall-config"),
    list: (query: DramaQuery) => {
      const params = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
      return send<Data<"m.drama.list">>(`/m/dramas?${params}`);
    },
    detail: (id: string) => send<Data<"m.drama.get">>(`/m/dramas/${encodeURIComponent(id)}`),
    cart: () => send<Data<"m.cartItem.list">>("/m/cart-items"),
    add: (id: string) =>
      send<Data<"m.cartItem.create">>("/m/cart-items", {
        method: "POST",
        data: { dramaId: id } satisfies Body<"m.cartItem.create">,
      }),
    remove: (id: string, idempotencyKey: string) =>
      send<null>(`/m/cart-items/${encodeURIComponent(id)}`, { method: "DELETE", idempotencyKey }),
    accept: (id: string, price: number, idempotencyKey: string) =>
      send<Data<"m.cartItem.acceptPrice">>(`/m/cart-items/${encodeURIComponent(id)}/accept-price`, {
        method: "POST",
        idempotencyKey,
        data: { acceptedPricePoints: price } satisfies Body<"m.cartItem.acceptPrice">,
      }),
  };
}
export const catalogApi = createCatalogApi(call);
