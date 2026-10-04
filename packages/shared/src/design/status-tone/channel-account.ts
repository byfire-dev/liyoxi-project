import { derived, entry, type StatusToneGroup } from "./types.js";

const COLUMN = "channel_account.status";

/** 渠道账号。枚举见 11 分组 第 3 节 */
export const channelAccount: StatusToneGroup = {
  key: "channel-account",
  object: "渠道账号",
  entries: [
    entry("待核验", COLUMN, ["pending_verify"], "info", "warning"),
    entry("可用", COLUMN, ["available"], "success", "success"),
    entry("异常", COLUMN, ["abnormal"], "danger", "danger"),
    derived(
      "核验未通过",
      "danger",
      "danger",
      "无枚举对应：状态为 abnormal 且异常来源 abnormal_source = verify 时的叫法",
    ),
    entry("已解绑", COLUMN, ["unbound"], "neutral", "neutral"),
  ],
};
