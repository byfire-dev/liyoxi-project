// 商家端：客服、消息与通用接口 · files（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mFileCreate = merchantMeta({
  method: "post",
  path: "/m/files",
  operationId: "m.file.create",
  summary:
    "上传登记（一次 1–9 个文件）：{category, licenseKind?, files[]: {fileName, sizeBytes, clientToken}} → items[]: FileRegistration（fileId、通道 post | multipart、写入区 bucket/region/key、post 表单或 sts 临时密钥、chunkSize、expiresAt、credentialsLeft）",
  "x-capability": "assert-in-handler",
  "x-clerk-view": "same",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_file_object_client_token_store", "uq_file_object_client_token_noscope"],
});

export const mFileGet = merchantMeta({
  method: "get",
  path: "/m/files/{fileId}",
  operationId: "m.file.get",
  summary: "查询文件入库状态",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mFileCancel = merchantMeta({
  method: "post",
  path: "/m/files/{fileId}/cancel",
  operationId: "m.file.cancel",
  summary: "取消上传（未入库的登记作废）",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});

export const mFileComplete = merchantMeta({
  method: "post",
  path: "/m/files/{fileId}/complete",
  operationId: "m.file.complete",
  summary: "上传确认（小文件最多等 3 秒入库），业务提交时再引用 fileId",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});

export const mFileRefreshCredentials = merchantMeta({
  method: "post",
  path: "/m/files/{fileId}/refresh-credentials",
  operationId: "m.file.refreshCredentials",
  summary: "续签分块上传的临时密钥（30 分钟有效）",
  "x-clerk-view": "same",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发上传凭证，结果不进幂等记录（C47、C59）",
});
