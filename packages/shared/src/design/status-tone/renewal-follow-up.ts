import { derived, entry, type StatusToneGroup } from "./types.js";

/** 跟进意向（03 分组 第 3 节）；其余几项是“套餐到期”页按套餐周期与审批推导的展示状态 */
const INTENT = "follow_up.intent";
const BY_TERM = "无枚举对应：“套餐到期”页的展示状态，由套餐周期、跟进记录与在途审批推导";

/** 续费跟进：只在后台出现。“待跟进”为红是照原型（规范 第 14 节第 6 项） */
export const renewalFollowUp: StatusToneGroup = {
  key: "renewal-follow-up",
  object: "续费跟进",
  entries: [
    derived("待跟进", null, "danger", BY_TERM),
    derived("已过期", null, "danger", BY_TERM),
    entry("考虑中", INTENT, ["considering"], null, "warning"),
    derived("延长审批中", null, "info", BY_TERM),
    entry("已确认续费", INTENT, ["confirmed"], null, "success"),
    derived("已续费", null, "success", BY_TERM),
    entry("暂不续费", INTENT, ["declined"], null, "neutral"),
  ],
};
