// 电脑端下载页 · files（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { portalMeta } from "../meta-only.js";

export const portalFileCreate = portalMeta({
  method: "post",
  path: "/portal/files",
  operationId: "portal.file.create",
  summary: "电脑端上传大文件的登记（V1.1 扩展位，V1.0 不做）",
  "x-auth": "portal",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_file_object_client_token_store"],
});
