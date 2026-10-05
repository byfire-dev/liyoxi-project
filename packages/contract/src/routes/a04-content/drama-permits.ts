// 后台：短剧库与积分价 · drama-permits（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDramaPermitUpdate = adminMeta({
  method: "patch",
  path: "/admin/drama-permits/{dramaPermitId}",
  operationId: "admin.dramaPermit.update",
  summary: "修改许可行",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaPermitRetire = adminMeta({
  method: "post",
  path: "/admin/drama-permits/{dramaPermitId}/retire",
  operationId: "admin.dramaPermit.retire",
  summary: "停用许可行",
  "x-permission": null,
  "x-idempotent": "required",
});
