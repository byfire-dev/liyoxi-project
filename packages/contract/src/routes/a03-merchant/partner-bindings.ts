// 后台：商家、资质审核与素材复核 · partner-bindings（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPartnerBindingList = adminMeta({
  method: "get",
  path: "/admin/partner-bindings",
  operationId: "admin.partnerBinding.list",
  summary: "商家归属记录（分页）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
