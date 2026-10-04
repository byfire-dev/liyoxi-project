import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "drama.status";

/** 短剧：只在后台出现。枚举见 05 分组 第 3 节 */
export const drama: StatusToneGroup = {
  key: "drama",
  object: "短剧",
  entries: [
    entry("已上架", COLUMN, ["listed"], null, "success"),
    entry("草稿", COLUMN, ["draft"], null, "neutral"),
    entry("已下架", COLUMN, ["delisted"], null, "neutral"),
  ],
};
