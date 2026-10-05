// 后台：短剧库与积分价 · upload-batches（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminUploadBatchCreate = adminMeta({
  method: "post",
  path: "/admin/upload-batches",
  operationId: "admin.uploadBatch.create",
  summary:
    "创建批量上传批次并逐集匹配（原片首次上传、批量替换原片；成片批次同用）：用途、目标、文件清单、范围、替换原因、AI 使用声明",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminUploadBatchGet = adminMeta({
  method: "get",
  path: "/admin/upload-batches/{uploadBatchId}",
  operationId: "admin.uploadBatch.get",
  summary: "批次详情与逐条进度（前端轮询）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminUploadBatchCancel = adminMeta({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/cancel",
  operationId: "admin.uploadBatch.cancel",
  summary: "取消批次",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminUploadBatchCommit = adminMeta({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/commit",
  operationId: "admin.uploadBatch.commit",
  summary: "提交原片批次：生成新原片版本，旧版本置 superseded；内容有实质变更时标记许可待重新核验",
  "x-permission": "drama.media.manage",
  "x-idempotent": "required",
});

export const adminUploadBatchStart = adminMeta({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/start",
  operationId: "admin.uploadBatch.start",
  summary: "确认匹配结果，开始上传",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminUploadBatchRefreshCredentials = adminMeta({
  method: "post",
  path: "/admin/upload-batches/{uploadBatchId}/refresh-credentials",
  operationId: "admin.uploadBatch.refreshCredentials",
  summary: "签发或续签整批的直传临时密钥（只能写批次前缀 incoming/b{uploadBatchId}/*，30 分钟）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时凭证，结果不进幂等记录（A18、C47）",
});
