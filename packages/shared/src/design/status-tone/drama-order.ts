import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "drama_order.status";

/** 订购单。枚举见 09 分组 第 3 节 */
export const dramaOrder: StatusToneGroup = {
  key: "drama-order",
  object: "订购单",
  entries: [
    entry("待开工", COLUMN, ["pending_start"], "info", "warning"),
    entry("制作中", COLUMN, ["producing"], "info", "info"),
    entry("待上线", COLUMN, ["to_launch"], "warning", "warning"),
    entry("上线中", COLUMN, ["live"], "success", "success"),
    entry("售后处理中", COLUMN, ["after_sale"], "info", "warning"),
    entry("已结束", COLUMN, ["ended"], "neutral", "neutral"),
    entry("已取消", COLUMN, ["cancelled"], "neutral", "neutral"),
    entry("已退回积分", COLUMN, ["refunded"], "neutral", "neutral"),
  ],
};
