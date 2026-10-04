import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "ad.status";

/** 广告视频。枚举见 09 分组 第 3 节 */
export const ad: StatusToneGroup = {
  key: "ad",
  object: "广告视频",
  entries: [
    entry("待指派", COLUMN, ["pending_assign"], null, "warning"),
    entry("制作中", COLUMN, ["producing"], "info", "info"),
    entry("修改中", COLUMN, ["revising"], "info", "info"),
    entry("待商家确认", COLUMN, ["pending_confirm"], ["warning", "待确认"], "info"),
    entry("已确认", COLUMN, ["confirmed"], "success", "success"),
  ],
};
