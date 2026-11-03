import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
let sceneRequest: Promise<RequestLayer["request"]> | null = null;
/** 生产经中央 request；固定离线数据仅由截图脚本显式注入。 */
export const billingRequest: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_BILLING_SHOT__?: string }).__LYX_BILLING_SHOT__;
    if (scene) {
      // 先缓存初始化意图；wallet/policy 并发首读必须共享同一夹具与调用记录。
      sceneRequest ??= import("../../../../shots/billing-fixtures").then((module) =>
        module.offlineBillingRequest(scene),
      );
      return (await sceneRequest)(path, options);
    }
  }
  return request(path, options);
};
