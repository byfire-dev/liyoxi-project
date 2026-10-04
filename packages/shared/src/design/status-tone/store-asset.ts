import { derived, entry, type StatusToneGroup } from "./types.js";

const PROCESSING = "store_asset.processing_state";
const USABILITY = "store_asset.usability";

/** 门店素材：处理进度与可用性两列。枚举见 06 分组 第 3 节 */
export const storeAsset: StatusToneGroup = {
  key: "store-asset",
  object: "门店素材",
  entries: [
    entry("整理中", PROCESSING, ["pending", "processing"], "info", ["info", "待整理"]),
    derived("已采用", "success", "success", "无枚举对应：素材被订购或广告采用过，由采用记录推导"),
    entry("可直接使用", USABILITY, ["ready"], "success", "success"),
    entry("需肖像授权", USABILITY, ["need_portrait_auth"], "warning", "warning"),
    entry("需补拍", USABILITY, ["need_reshoot"], "warning", "warning"),
    entry("仅供参考", USABILITY, ["reference_only"], "neutral", "neutral"),
    entry("已整理", PROCESSING, ["processed"], "neutral", "neutral"),
  ],
};
