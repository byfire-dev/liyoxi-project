// 商家端：客服、消息与通用接口 · subscribe-results（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mSubscribeResultCreate = merchantMeta({
  method: "post",
  path: "/m/subscribe-results",
  operationId: "m.subscribeResult.create",
  summary: "订阅消息授权结果上报：{reportId, point, results: [{tmplId, accept|reject|ban|filter}]}",
  "x-auth": "user",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});
