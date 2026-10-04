import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "recon_day.status";

/** 对账：只在后台出现。枚举见 08 分组 第 3 节 */
export const reconciliation: StatusToneGroup = {
  key: "reconciliation",
  object: "对账",
  entries: [
    entry("待对账", COLUMN, ["wait"], null, "neutral"),
    entry("有差异", COLUMN, ["diff"], null, "danger"),
    entry("已对平", COLUMN, ["ok"], null, "success"),
    entry("已处理差异", COLUMN, ["fixed"], null, "success"),
  ],
};
