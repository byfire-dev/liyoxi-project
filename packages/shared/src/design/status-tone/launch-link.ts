import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "launch_task.review_status";

/** 上线链接：发布任务最近一轮回填的审核结果。枚举见 11 分组 第 3 节 */
export const launchLink: StatusToneGroup = {
  key: "launch-link",
  object: "上线链接",
  entries: [
    entry("待发布", COLUMN, ["pending"], "warning", null, { note: "库里的含义是“待回填”" }),
    entry("核验中", COLUMN, ["verifying"], "info", ["warning", "待核验"]),
    entry("已核验", COLUMN, ["passed"], "success", "success"),
    entry("核验未通过", COLUMN, ["need_fix"], "danger", "danger", {
      note: "库里的含义是“需补充”",
    }),
  ],
};
