// 后台：登录、员工、权限与系统 · files（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminFileList = adminMeta({
  method: "get",
  path: "/admin/files",
  operationId: "admin.file.list",
  summary: "文件查询（如已清除、保留期内可恢复的文件）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminFileCreate = adminMeta({
  method: "post",
  path: "/admin/files",
  operationId: "admin.file.create",
  summary:
    "上传登记（证照代传、发票文件、转账回单、Banner 图、协议正文、样片、广告版本、预告片、核查截图、巡检截图等），返回 fileId 与直传凭证",
  "x-permission": "assert-in-handler",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_file_object_client_token_store", "uq_file_object_client_token_noscope"],
});

export const adminFileGet = adminMeta({
  method: "get",
  path: "/admin/files/{fileId}",
  operationId: "admin.file.get",
  summary: "查询文件入库与体检状态（前端轮询）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminFileComplete = adminMeta({
  method: "post",
  path: "/admin/files/{fileId}/complete",
  operationId: "admin.file.complete",
  summary: "上传完成确认，服务端核对对象并入库（触发体检）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  "x-idempotent-reason": "状态迁移（C59）；多事务的三段式用例",
});

export const adminFileDownloadUrls = adminMeta({
  method: "post",
  path: "/admin/files/{fileId}/download-urls",
  operationId: "admin.file.downloadUrls",
  summary:
    "签发文件的短时读地址（证照 5 分钟、样片与广告 60 分钟、成片 30 分钟），按分类判权并逐次留痕",
  "x-permission": "assert-in-handler",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录（A18）",
});

export const adminFileErase = adminMeta({
  method: "post",
  path: "/admin/files/{fileId}/erase",
  operationId: "admin.file.erase",
  summary: "彻底删除文件的全部历史版本",
  "x-permission": "files.erase",
  "x-idempotent": "required",
  "x-idempotent-reason": "状态迁移；多事务的三段式用例（C51）",
});

export const adminFileRefreshCredentials = adminMeta({
  method: "post",
  path: "/admin/files/{fileId}/refresh-credentials",
  operationId: "admin.file.refreshCredentials",
  summary: "续签直传临时密钥（大文件分块上传中途过期）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发上传凭证（C47 本稿归类）",
});

export const adminFileRestore = adminMeta({
  method: "post",
  path: "/admin/files/{fileId}/restore",
  operationId: "admin.file.restore",
  summary: "恢复已清除文件（历史版本保留期内；填写原因）",
  "x-permission": "files.restore",
  "x-idempotent": "required",
  "x-idempotent-reason": "状态迁移；三段式用例（先调外部、再开事务）",
});

export const adminFileCancel = adminMeta({
  method: "post",
  path: "/admin/files/{fileId}/cancel",
  operationId: "admin.file.cancel",
  summary: "上传人本人取消未确认的上传登记（pending → expired，清空写入区键）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  "x-idempotent-reason": "状态迁移（A17）",
});
