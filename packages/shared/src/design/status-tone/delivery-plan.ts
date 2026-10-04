import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "delivery_plan.status";

/** 交付方案：只在商家端出现。枚举见 10 分组 第 3 节 */
export const deliveryPlan: StatusToneGroup = {
  key: "delivery-plan",
  object: "交付方案",
  entries: [
    entry("待确认", COLUMN, ["pending_confirm"], "warning", null),
    entry("修改中", COLUMN, ["revising"], "info", null),
    entry("已确认", COLUMN, ["confirmed"], "success", null),
  ],
};
