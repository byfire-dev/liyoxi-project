// 商家端：客服、消息与通用接口 · notify-settings（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mNotifySettingList = merchantMeta({
  method: "get",
  path: "/m/notify-settings",
  operationId: "m.notifySetting.list",
  summary:
    "通知设置：各类订阅消息（审核结果、付款结果、到期提醒、交付进度、待办提醒、工单回复、开票结果等槽位）的当前状态与可请求的模板 id",
  "x-auth": "user",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
