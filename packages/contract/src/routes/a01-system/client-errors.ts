// 后台：登录、员工、权限与系统 · client-errors（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { acceptedResponse, errorResponses, SentryEnvelopeSchema } from "../../common/index.js";
import { adminRoute } from "../builders.js";

export const adminClientErrorCreate = adminRoute({
  method: "post",
  path: "/admin/client-errors",
  operationId: "admin.clientError.create",
  summary: "后台前端错误上报转发（同源）",
  "x-auth": "optional",
  "x-permission": null,
  "x-idempotent": "none",
  "x-idempotent-reason": "错误上报（A18）",
  request: {
    body: {
      required: true,
      content: { "application/x-sentry-envelope": { schema: SentryEnvelopeSchema } },
    },
  },
  responses: { ...acceptedResponse(), ...errorResponses(400, 429) },
});
