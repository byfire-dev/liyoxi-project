import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "approval_request.status";

/** 审批（积分调整、入驻、归属）：只在后台出现。枚举见 03 分组 第 3 节 */
export const approval: StatusToneGroup = {
  key: "approval",
  object: "审批（积分调整、入驻、归属）",
  entries: [
    entry("待审批", COLUMN, ["pending"], null, "warning", {
      note: "入驻与归属写“待审核”",
    }),
    entry("已通过", COLUMN, ["approved"], null, "success"),
    entry("已驳回", COLUMN, ["rejected"], null, "danger"),
  ],
};
