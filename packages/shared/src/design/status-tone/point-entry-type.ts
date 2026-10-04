import { derived, type StatusToneGroup } from "./types.js";

const NOTE =
  "无枚举对应：分类标签，按账本操作类型（ledger_operation.op_type）归并；商家端不用类型标签，用数字颜色";

/** 积分流水类型：后台的分类标签。紫色只在后台用 */
export const pointEntryType: StatusToneGroup = {
  key: "point-entry-type",
  object: "积分流水类型",
  entries: [
    derived("发放", null, "success", NOTE),
    derived("退回", null, "success", NOTE),
    derived("加购", null, "info", NOTE),
    derived("冻结", null, "warning", NOTE),
    derived("扣减", null, "neutral", NOTE),
    derived("清零", null, "neutral", NOTE),
    derived("调整", null, "purple", NOTE),
  ],
};
