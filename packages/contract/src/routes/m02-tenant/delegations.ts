// 商家端：主体、门店与成员 · delegations（docs/api/m02-tenant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mDelegationCreate = merchantMeta({
  method: "post",
  path: "/m/delegations",
  operationId: "m.delegation.create",
  summary:
    "V1.1：老板授权管理员代为确认方案、样片、广告（委托人、受托成员、能力点、门店范围、有效期）",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
