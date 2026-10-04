import { entry, type StatusToneGroup } from "./types.js";

/** 成员邀请。枚举见 02 分组 第 3 节 */
export const invitation: StatusToneGroup = {
  key: "invitation",
  object: "成员邀请",
  entries: [entry("待接受", "invitation.status", ["pending"], "info", "info")],
};
