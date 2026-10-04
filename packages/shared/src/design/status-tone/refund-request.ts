import { derived, entry, type StatusToneGroup } from "./types.js";

const COLUMN = "refund_request.status";

/** 退款单：只在后台出现。枚举见 08 分组 第 3 节 */
export const refundRequest: StatusToneGroup = {
  key: "refund-request",
  object: "退款单",
  entries: [
    entry("待审批", COLUMN, ["pending_approval"], null, "warning"),
    entry("待执行", COLUMN, ["pending_execution"], null, "info"),
    entry("已退款", COLUMN, ["done"], null, "success"),
    derived(
      "已驳回",
      null,
      "danger",
      "无枚举对应：状态为 not_executed（未执行即关闭）且关闭原因是驳回；撤回、作废不算",
    ),
  ],
};
