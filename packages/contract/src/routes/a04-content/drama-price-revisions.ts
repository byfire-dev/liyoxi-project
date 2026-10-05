// 后台：短剧库与积分价 · drama-price-revisions（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDramaPriceRevisionList = adminMeta({
  method: "get",
  path: "/admin/drama-price-revisions",
  operationId: "admin.dramaPriceRevision.list",
  summary: "调价记录（含待生效、已撤销）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaPriceRevisionWithdraw = adminMeta({
  method: "post",
  path: "/admin/drama-price-revisions/{dramaPriceRevisionId}/withdraw",
  operationId: "admin.dramaPriceRevision.withdraw",
  summary: "撤销尚未生效的调价",
  "x-permission": "billing.price.edit",
  "x-idempotent": "required",
});
