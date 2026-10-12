import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export type AssetCreateBody = Body<"m.storeAsset.create">;
export type AssetCreated = Data<"m.storeAsset.create">;
export type DemandPage = Data<"m.assetDemand.list">;
export type UploadTags = Data<"m.dictItem.list">["items"][number]["items"];
export function createAssetUploadApi(send: RequestLayer["request"]) {
  return {
    create: (data: AssetCreateBody, idempotencyKey: string) =>
      send<AssetCreated>("/m/store-assets", { method: "POST", data, idempotencyKey }),
    demands: (cursor?: string) =>
      send<DemandPage>(
        `/m/asset-demands?status=open&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    tags: async (): Promise<UploadTags> => {
      const data = await send<Data<"m.dictItem.list">>(
        "/m/dict-items?typeKey=asset_tag&includeDisabled=false",
      );
      return data.items
        .filter((type) => type.typeKey === "asset_tag")
        .flatMap((type) => type.items)
        .filter((item) => item.isSelectable && item.ext.dimension === "content");
    },
  };
}
export type AssetUploadApi = ReturnType<typeof createAssetUploadApi>;
