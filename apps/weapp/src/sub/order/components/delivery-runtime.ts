import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
let sceneCall: Promise<RequestLayer["request"]> | null = null;
export const deliveryRequest: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_DELIVERY_SHOT__?: string }).__LYX_DELIVERY_SHOT__;
    if (scene) {
      sceneCall ??= import("../../../../shots/delivery-fixtures").then((m) =>
        m.offlineDeliveryRequest(scene),
      );
      return (await sceneCall)(path, options);
    }
  }
  return request(path, options);
};
