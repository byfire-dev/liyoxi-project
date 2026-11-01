import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
import { createCatalogApi } from "@/pages/mall/api";

export function createTrailerApi(send: RequestLayer["request"]) {
  return {
    ...createCatalogApi(send),
    playable: (id: string) =>
      send<Data<"m.playable.get">>(`/m/playables/${encodeURIComponent(id)}`),
  };
}
let sceneCall: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_TRAILER_SHOT__?: string }).__LYX_TRAILER_SHOT__;
    if (scene) {
      sceneCall ??= (await import("../../../../shots/trailer-fixtures")).offlineTrailerRequest(
        scene,
      );
      return sceneCall(path, options);
    }
  }
  return request(path, options);
};
export const trailerApi = createTrailerApi(call);
export type TrailerApi = ReturnType<typeof createTrailerApi>;
