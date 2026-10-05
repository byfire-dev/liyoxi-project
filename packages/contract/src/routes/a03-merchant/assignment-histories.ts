// 后台：商家、资质审核与素材复核 · assignment-histories（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAssignmentHistoryMarkContacted = adminMeta({
  method: "post",
  path: "/admin/assignment-histories/{assignmentHistoryId}/mark-contacted",
  operationId: "admin.assignmentHistory.markContacted",
  summary: "新交付经理标记“已联系商家”（关闭联系时限）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
