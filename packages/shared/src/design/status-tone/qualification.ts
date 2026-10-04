import { derived, entry, type StatusToneGroup } from "./types.js";

/** 主体的 entity.verification_status 用同一组取值（02 分组 第 3 节） */
const COLUMN = "store.qualification_status";

/** 资质审核 */
export const qualification: StatusToneGroup = {
  key: "qualification",
  object: "资质审核",
  entries: [
    entry("未提交", COLUMN, ["unsubmitted"], "neutral", "neutral"),
    entry("审核中", COLUMN, ["pending"], "info", ["warning", "待审核"]),
    entry("已通过", COLUMN, ["verified"], "success", "success", {
      note: "门店状态标签写“已认证”，不并入“已通过”（规范 第 6.3 节）",
    }),
    entry("已驳回", COLUMN, ["rejected"], "danger", "danger"),
    derived(
      "证照模糊",
      "danger",
      "danger",
      "无枚举对应：驳回原因的字典项（字典分类 store_review），不是状态",
    ),
    derived(
      "无法识别",
      "danger",
      "danger",
      "无枚举对应：证照识别不出来时的标签，不是资质状态",
    ),
  ],
};
