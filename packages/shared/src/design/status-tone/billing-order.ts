import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "billing_order.status";

/** 付款单。枚举见 08 分组 第 3 节 */
export const billingOrder: StatusToneGroup = {
  key: "billing-order",
  object: "付款单",
  entries: [
    entry("待支付", COLUMN, ["pending_payment"], "warning", "warning"),
    entry("待确认收款", COLUMN, ["pending_confirmation"], "info", "warning"),
    entry("已支付", COLUMN, ["paid"], "success", "success"),
    entry("已取消", COLUMN, ["cancelled"], "neutral", "neutral"),
    entry("已退款", COLUMN, ["refunded"], "neutral", "neutral"),
  ],
};
