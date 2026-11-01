import type { operations } from "@liyoxi/contract/types/merchant";
import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
import type { Ad, AdPage, AdQuote, AdTab } from "./types";
export type { Ad, AdPage, AdQuote, AdTab, AdKind } from "./types";
let offline: Promise<RequestLayer["request"]> | undefined;
export const adRequest: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_AD_SHOT__?: string }).__LYX_AD_SHOT__;
    if (scene) {
      offline ??= import("../../../../shots/ad-fixtures").then((m) => m.offlineAdRequest(scene));
      return (await offline)(path, options);
    }
  }
  return request(path, options);
};
export function createAdApi(send: RequestLayer["request"]) {
  const base = (id: string) => `/m/ads/${encodeURIComponent(id)}`;
  const write = <K extends keyof operations>(path: string, data: Body<K>, key: string) =>
    send<Data<K>>(path, { method: "POST", data, idempotencyKey: key });
  return {
    list: (tab: AdTab, cursor?: string) =>
      send<AdPage>(
        `/m/ads?tab=${tab}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    get: (id: string) => send<Ad>(base(id)),
    quote: (data: Body<"m.ad.quote">) => send<AdQuote>("/m/ads/quote", { method: "POST", data }),
    create: (data: Body<"m.ad.create">, key: string) => write<"m.ad.create">("/m/ads", data, key),
    confirm: (id: string, data: Body<"m.ad.confirm">, key: string) =>
      write<"m.ad.confirm">(`${base(id)}/confirm`, data, key),
    change: (id: string, data: Body<"m.ad.requestChange">, key: string) =>
      write<"m.ad.requestChange">(`${base(id)}/request-change`, data, key),
    submit: (id: string, data: Body<"m.ad.submit">, key: string) =>
      write<"m.ad.submit">(`${base(id)}/submit`, data, key),
    download: (id: string, versionNo: number) =>
      send<Data<"m.ad.downloadUrls">>(`${base(id)}/download-urls`, {
        method: "POST",
        data: { versionNo } satisfies Body<"m.ad.downloadUrls">,
      }),
    playable: (id: string) =>
      send<Data<"m.playable.get">>(`/m/playables/${encodeURIComponent(id)}`),
    promo: () => send<Data<"m.dictItem.list">>("/m/dict-items?typeKey=ad_promo_point"),
    references: (cursor?: string) =>
      send<Data<"m.storeAsset.list">>(
        `/m/store-assets?isSelectableAsReference=true&limit=20&sort=-createdAt${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
  };
}
export const adApi = createAdApi(adRequest);
