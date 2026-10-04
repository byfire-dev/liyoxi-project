import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "billing_account.sub_status";

/** 套餐：计费账户上的套餐状态。枚举见 07 分组 第 3 节 */
export const subscription: StatusToneGroup = {
  key: "subscription",
  object: "套餐",
  entries: [
    entry("生效中", COLUMN, ["active"], "success", "success"),
    entry("已过期", COLUMN, ["expired"], "danger", "danger"),
    entry("未开通", COLUMN, ["none"], null, "neutral"),
  ],
};
