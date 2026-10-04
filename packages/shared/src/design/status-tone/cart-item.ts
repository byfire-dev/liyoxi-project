import { derived, type StatusToneGroup } from "./types.js";

/** 选剧单条目：只在商家端出现 */
export const cartItem: StatusToneGroup = {
  key: "cart-item",
  object: "选剧单条目",
  entries: [
    derived(
      "已失效",
      "danger",
      null,
      "无枚举对应：选剧单里的剧已下架（drama.status = delisted），需要商家移除，属于出错",
    ),
  ],
};
