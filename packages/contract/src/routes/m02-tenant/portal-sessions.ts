// 商家端：主体、门店与成员 · portal-sessions（docs/api/m02-tenant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mPortalSessionList = merchantMeta({
  method: "get",
  path: "/m/portal-sessions",
  operationId: "m.portalSession.list",
  summary: "已授权的电脑列表（浏览器、地区、授权时间、到期时间）",
  "x-capability": "portal.authorize",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mPortalSessionRevoke = merchantMeta({
  method: "post",
  path: "/m/portal-sessions/{portalSessionId}/revoke",
  operationId: "m.portalSession.revoke",
  summary: "撤销某台电脑的下载页授权",
  "x-capability": "portal.authorize",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
