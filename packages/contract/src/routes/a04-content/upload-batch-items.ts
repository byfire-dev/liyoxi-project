// 后台：短剧库与积分价 · upload-batch-items（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminUploadBatchItemUpdate = adminMeta({
  method: "patch",
  path: "/admin/upload-batch-items/{uploadBatchItemId}",
  operationId: "admin.uploadBatchItem.update",
  summary: "修改批次条目：集号映射、跳过（仅 partial 批次）、同一集换新文件",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminUploadBatchItemComplete = adminMeta({
  method: "post",
  path: "/admin/upload-batch-items/{uploadBatchItemId}/complete",
  operationId: "admin.uploadBatchItem.complete",
  summary: "批次内单个文件上传完成确认",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
