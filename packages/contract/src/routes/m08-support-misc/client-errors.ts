// 商家端：客服、消息与通用接口 · client-errors（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { acceptedResponse, errorResponses, SentryEnvelopeSchema } from "../../common/index.js";
import { merchantRoute } from "../builders.js";

export const mClientErrorCreate = merchantRoute({
  method: "post",
  path: "/m/client-errors",
  operationId: "m.clientError.create",
  summary: "小程序错误上报转发（Sentry envelope，≤200KB、白名单、限流，立即 202）",
  "x-auth": "optional",
  "x-clerk-view": "same",
  "x-idempotent": "none",
  "x-idempotent-reason": "错误上报（A18、C47）",
  request: {
    body: {
      required: true,
      content: { "application/x-sentry-envelope": { schema: SentryEnvelopeSchema } },
    },
  },
  responses: { ...acceptedResponse(), ...errorResponses(400, 429) },
});
