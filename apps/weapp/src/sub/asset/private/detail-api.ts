import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type FeedbackBody = Body<"m.storeAsset.feedback.create">;
export type PortraitBody = Body<"m.storeAsset.portraitAuth.create">;
export function createAssetDetailApi(send: RequestLayer["request"]) {
  const path = (id: string) => `/m/store-assets/${encodeURIComponent(id)}`;
  return {
    feedback: (id: string, data: FeedbackBody, idempotencyKey: string) =>
      send<Data<"m.storeAsset.feedback.create">>(`${path(id)}/feedback`, {
        method: "POST",
        data,
        idempotencyKey,
      }),
    portrait: (id: string, data: PortraitBody, idempotencyKey: string) =>
      send<Data<"m.storeAsset.portraitAuth.create">>(`${path(id)}/portrait-auth`, {
        method: "POST",
        data,
        idempotencyKey,
      }),
  };
}
export type AssetDetailApi = ReturnType<typeof createAssetDetailApi>;
