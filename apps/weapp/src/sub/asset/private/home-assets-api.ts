import type { RequestLayer } from "@/lib/request";
import { createAssetApi } from "./api";
import { createAssetUploadApi } from "./upload-api";

/** 首页只读当前门店开放需求与本人的服务端计数，不另拉素材列表。 */
export function createHomeAssetsApi(send: RequestLayer["request"]) {
  const assets = createAssetApi(send),
    upload = createAssetUploadApi(send);
  return {
    demands: upload.demands,
    summary: () => assets.summary({ uploader: "me" }),
  };
}
export type HomeAssetsApi = ReturnType<typeof createHomeAssetsApi>;
