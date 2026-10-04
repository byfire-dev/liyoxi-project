import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "staff.status";

/** 员工账号：只在后台出现。枚举见 03 分组 第 3 节 */
export const staff: StatusToneGroup = {
  key: "staff",
  object: "员工账号",
  entries: [
    entry("启用", COLUMN, ["active"], null, "success"),
    entry("待启用", COLUMN, ["pending"], null, "info"),
    entry("已禁用", COLUMN, ["disabled"], null, "neutral"),
  ],
};
