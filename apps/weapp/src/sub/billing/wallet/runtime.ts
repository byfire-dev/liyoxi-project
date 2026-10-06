import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
let sceneRequest: RequestLayer["request"] | null = null;
/** 生产经中央 request；固定离线数据仅由截图脚本显式注入。 */
export const billingRequest: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_BILLING_SHOT__?: string }).__LYX_BILLING_SHOT__;
    if (scene) {
      sceneRequest ??= (await import("../../../../shots/billing-fixtures")).offlineBillingRequest(
        scene,
      );
      return sceneRequest(path, options);
    }
  }
  return request(path, options);
};
