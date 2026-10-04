import { derived, type StatusToneGroup } from "./types.js";

const NOTE = "无枚举对应：V1.1 的对象，V1.0 的数据模型里还没有这张表";

/** 服务商结算单（V1.1）：只在后台出现 */
export const partnerSettlement: StatusToneGroup = {
  key: "partner-settlement",
  object: "服务商结算单（V1.1）",
  entries: [
    derived("待生成", null, "neutral", NOTE),
    derived("待服务商确认", null, "warning", NOTE),
    derived("待打款", null, "info", NOTE),
    derived("已打款", null, "success", NOTE),
    derived("有异议", null, "danger", NOTE),
  ],
};
