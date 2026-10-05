// 商家端：交付与发布 · performance-uploads（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mPerformanceUploadCreate = merchantMeta({
  method: "post",
  path: "/m/performance-uploads",
  operationId: "m.performanceUpload.create",
  summary: "V1.1：商家每周上传作品数据截图，发布专员审核后录入",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
