import { derived, type StatusToneGroup } from "./types.js";

const NOTE =
  "无枚举对应：由上下架开关（plan.is_listed、point_pack.is_listed）与价目修订的生效时间推导，不存状态列";

/** 套餐与积分包的上架管理：只在后台出现 */
export const listing: StatusToneGroup = {
  key: "listing",
  object: "套餐与积分包（上架管理）",
  entries: [
    derived("已上架", null, "success", NOTE),
    derived("调整待生效", null, "info", NOTE),
    derived("已下架", null, "neutral", NOTE),
  ],
};
