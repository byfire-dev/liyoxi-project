// 电脑端下载页 · client-errors（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { portalMeta } from "../meta-only.js";

export const portalClientErrorCreate = portalMeta({
  method: "post",
  path: "/portal/client-errors",
  operationId: "portal.clientError.create",
  summary: "下载页前端错误上报（Sentry envelope）同源转发，收到即回 202",
  "x-auth": "optional",
  "x-idempotent": "none",
  "x-idempotent-reason": "埋点与错误上报（A18；C47）：转发后即丢，不落库，不经幂等记录",
});
