// 商家端：交付与发布 · downloads（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mDownloadReport = merchantMeta({
  method: "post",
  path: "/m/downloads/{downloadId}/report",
  operationId: "m.download.report",
  summary: "回报保存相册的结果 {result: saved | failed}",
  "x-capability": "delivery.download",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
