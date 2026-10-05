// 后台：工作台、报表与导出 · staff-messages（docs/api/a02-workbench-report.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminStaffMessageList = adminMeta({
  method: "get",
  path: "/admin/staff-messages",
  operationId: "admin.staffMessage.list",
  summary: "后台铃铛：员工站内消息列表",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminStaffMessageBatchRead = adminMeta({
  method: "post",
  path: "/admin/staff-messages/read",
  operationId: "admin.staffMessage.batchRead",
  summary: "全部标记已读",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminStaffMessageSummary = adminMeta({
  method: "get",
  path: "/admin/staff-messages/summary",
  operationId: "admin.staffMessage.summary",
  summary: "后台铃铛未读数（按消息类别分组）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminStaffMessageRead = adminMeta({
  method: "post",
  path: "/admin/staff-messages/{staffMessageId}/read",
  operationId: "admin.staffMessage.read",
  summary: "标记一条站内消息已读",
  "x-permission": null,
  "x-idempotent": "required",
});
