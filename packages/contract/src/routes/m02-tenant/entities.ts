// 商家端：主体、门店与成员 · entities（docs/api/m02-tenant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mEntityCreate = merchantMeta({
  method: "post",
  path: "/m/entities",
  operationId: "m.entity.create",
  summary:
    "懒创建经营主体 + 首家门店 + 老板成员关系 + 计费账户；已是老板返回已有主体，已是别家店员返回 409 ALREADY_IN_ENTITY",
  "x-auth": "user",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});
