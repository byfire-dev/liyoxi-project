// 后台：订购、取消、交付与广告任务 · license-letter-revisions（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminLicenseLetterRevisionRerender = adminMeta({
  method: "post",
  path: "/admin/license-letter-revisions/{licenseLetterRevisionId}/rerender",
  operationId: "admin.licenseLetterRevision.rerender",
  summary: "授权书版次渲染失败后重新生成",
  "x-permission": "order.license_letter.manage",
  "x-idempotent": "required",
});
