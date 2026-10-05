// 后台：内容运营与通知配置 · notices（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminNoticeList = adminMeta({
  method: "get",
  path: "/admin/notices",
  operationId: "admin.notice.list",
  summary: "公告列表",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminNoticeCreate = adminMeta({
  method: "post",
  path: "/admin/notices",
  operationId: "admin.notice.create",
  summary: "新建公告（保存草稿）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminNoticeUpdate = adminMeta({
  method: "patch",
  path: "/admin/notices/{noticeId}",
  operationId: "admin.notice.update",
  summary: "编辑公告",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminNoticePublish = adminMeta({
  method: "post",
  path: "/admin/notices/{noticeId}/publish",
  operationId: "admin.notice.publish",
  summary: "立即或定时发布公告",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminNoticeUnpublish = adminMeta({
  method: "post",
  path: "/admin/notices/{noticeId}/unpublish",
  operationId: "admin.notice.unpublish",
  summary: "下线公告",
  "x-permission": null,
  "x-idempotent": "required",
});
