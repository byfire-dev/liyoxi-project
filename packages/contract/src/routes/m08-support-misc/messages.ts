// 商家端：客服、消息与通用接口 · messages（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mMessageList = merchantMeta({
  method: "get",
  path: "/m/messages",
  operationId: "m.message.list",
  summary:
    "站内消息（?tab=&cursor=，游标分页）：分类、标题、正文、按钮文案、深链、未读标记；按今天/昨天/日期分组",
  "x-auth": "user",
  "x-capability": "assert-in-handler",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mMessageBatchRead = merchantMeta({
  method: "post",
  path: "/m/messages/read",
  operationId: "m.message.batchRead",
  summary: "全部已读 {tab?, upToMessageId} → {markedCount, summary}",
  "x-auth": "user",
  "x-capability": "assert-in-handler",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});

export const mMessageSummary = merchantMeta({
  method: "get",
  path: "/m/messages/summary",
  operationId: "m.message.summary",
  summary:
    "未读计数：total、byTab（数组 [{tab, unreadCount}]，tab 取值与列表一致）、byStore（[{storeId, unreadCount}]）",
  "x-auth": "user",
  "x-capability": "assert-in-handler",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mMessageRead = merchantMeta({
  method: "post",
  path: "/m/messages/{messageId}/read",
  operationId: "m.message.read",
  summary: "标记单条已读（点击消息跳转时）",
  "x-auth": "user",
  "x-capability": "assert-in-handler",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});
