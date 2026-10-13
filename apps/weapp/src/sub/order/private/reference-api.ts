import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export type ReferencePage = Data<"m.storeAsset.list">;
export type ReferenceCard = ReferencePage["items"][number];
export function createOrderReferenceApi(send: RequestLayer["request"]) {
  return {
    list: (cursor?: string) =>
      send<ReferencePage>(
        `/m/store-assets?isSelectableAsReference=true&limit=20&sort=-createdAt${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    byIds: (ids: readonly string[]) =>
      send<ReferencePage>(`/m/store-assets?ids=${encodeURIComponent(ids.join(","))}&limit=20`),
  };
}
export type OrderReferenceApi = ReturnType<typeof createOrderReferenceApi>;
