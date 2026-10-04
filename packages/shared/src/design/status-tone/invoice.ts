import { derived, entry, type StatusToneGroup } from "./types.js";

const COLUMN = "invoice_request.status";

/** 发票。枚举见 08 分组 第 3 节 */
export const invoice: StatusToneGroup = {
  key: "invoice",
  object: "发票",
  entries: [
    entry("开票中", COLUMN, ["pending"], "info", ["warning", "待开票"]),
    entry("已开具", COLUMN, ["issued"], "success", "success"),
    derived("已寄出", "success", "success", "无枚举对应：状态为 issued 的纸质发票的叫法"),
    entry("已驳回", COLUMN, ["rejected"], "danger", "danger"),
  ],
};
