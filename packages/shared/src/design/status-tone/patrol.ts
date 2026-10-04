import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "patrol_task.status";

/** 巡检：只在后台出现。枚举见 11 分组 第 3 节 */
export const patrol: StatusToneGroup = {
  key: "patrol",
  object: "巡检",
  entries: [
    entry("待巡检", COLUMN, ["pending"], null, "neutral"),
    entry("正常", COLUMN, ["normal"], null, "success"),
    entry("异常", COLUMN, ["abnormal"], null, "danger"),
  ],
};
