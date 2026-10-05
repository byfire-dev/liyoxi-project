// 后台：登录、员工、权限与系统 · media-jobs（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminMediaJobList = adminMeta({
  method: "get",
  path: "/admin/media-jobs",
  operationId: "admin.mediaJob.list",
  summary: "媒体任务监控（失败列表：转码、体检、OCR、打包等）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminMediaJobRetry = adminMeta({
  method: "post",
  path: "/admin/media-jobs/{mediaJobId}/retry",
  operationId: "admin.mediaJob.retry",
  summary: "媒体任务人工重试",
  "x-permission": "media.job.retry",
  "x-idempotent": "required",
});
