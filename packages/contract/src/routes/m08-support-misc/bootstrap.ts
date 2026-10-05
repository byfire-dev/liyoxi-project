// 商家端：客服、消息与通用接口 · bootstrap（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mBootstrapGet = merchantMeta({
  method: "get",
  path: "/m/bootstrap",
  operationId: "m.bootstrap.get",
  summary:
    "启动引导：serverTime、minClientVersion、flags、versions（dict/site/agreement）、uploadLimits、download.weappSaveMode、copy、support（在线客服模式）、degraded、notice（停机维护说明）、pendingConsents、subscribePlan、context",
  "x-auth": "optional",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
