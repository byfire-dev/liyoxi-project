// 后台：客服工单 · quick-replies（docs/api/a08-support.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminQuickReplyList = adminMeta({
  method: "get",
  path: "/admin/quick-replies",
  operationId: "admin.quickReply.list",
  summary: "快捷回复列表（由客服主管维护）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
