import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "service_ticket.status";

/** 客服工单。枚举见 12 分组 第 3 节 */
export const serviceTicket: StatusToneGroup = {
  key: "service-ticket",
  object: "客服工单",
  entries: [
    entry("待受理", COLUMN, ["pending"], "warning", "warning"),
    entry("处理中", COLUMN, ["processing"], "info", "info"),
    entry("待商家确认", COLUMN, ["awaiting_confirm"], ["warning", "待您确认"], "info"),
    entry("已解决", COLUMN, ["resolved"], "success", "success"),
    entry("已关闭", COLUMN, ["closed"], "neutral", "neutral"),
  ],
};
