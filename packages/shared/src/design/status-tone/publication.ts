import { derived, entry, type StatusToneGroup } from "./types.js";

/** 协议版本有状态列（13 分组 第 3 节）；公告与运营位的状态由起止时间与启用开关推导（14 分组） */
const AGREEMENT = "agreement_version.status";
const BY_TIME = "无枚举对应：公告、运营位的展示状态，由起止时间与启用开关推导";

/** 协议、公告、运营位 */
export const publication: StatusToneGroup = {
  key: "publication",
  object: "协议、公告、运营位",
  entries: [
    entry("草稿", AGREEMENT, ["draft"], null, "neutral"),
    entry("待生效", AGREEMENT, ["pending"], "info", "info"),
    derived("已排期", "info", "info", BY_TIME),
    derived("定时发布", "info", "info", BY_TIME),
    entry("生效中", AGREEMENT, ["active"], "success", "success"),
    derived("已发布", "success", "success", BY_TIME),
    entry("已失效", AGREEMENT, ["superseded"], "neutral", "neutral"),
    derived("已结束", "neutral", "neutral", BY_TIME),
    derived("已下线", "neutral", "neutral", BY_TIME),
    derived("已停用", "neutral", "neutral", BY_TIME),
  ],
};
