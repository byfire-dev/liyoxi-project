// 后台：内容运营与通知配置 · faqs（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminFaqList = adminMeta({
  method: "get",
  path: "/admin/faqs",
  operationId: "admin.faq.list",
  summary: "常见问题列表（按分类）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminFaqCreate = adminMeta({
  method: "post",
  path: "/admin/faqs",
  operationId: "admin.faq.create",
  summary: "新增常见问题",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminFaqUpdate = adminMeta({
  method: "patch",
  path: "/admin/faqs/{faqId}",
  operationId: "admin.faq.update",
  summary: "编辑常见问题",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminFaqDelete = adminMeta({
  method: "delete",
  path: "/admin/faqs/{faqId}",
  operationId: "admin.faq.delete",
  summary: "删除常见问题（建议软删）",
  "x-permission": null,
  "x-idempotent": "required",
});
