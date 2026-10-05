// 后台：商家、资质审核与素材复核 · partner-levels（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPartnerLevelList = adminMeta({
  method: "get",
  path: "/admin/partner-levels",
  operationId: "admin.partnerLevel.list",
  summary: "服务商等级、返佣比例与评定标准",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPartnerLevelReplace = adminMeta({
  method: "put",
  path: "/admin/partner-levels/{levelKey}",
  operationId: "admin.partnerLevel.replace",
  summary: "编辑等级比例、门槛与生效时间（立即或下月 1 日）",
  "x-permission": null,
  "x-idempotent": "required",
});
