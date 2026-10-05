// 外部回调与探活 · esign（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookMeta } from "../meta-only.js";

export const hooksEsignEventReceive = hookMeta({
  method: "post",
  path: "/hooks/esign/events",
  operationId: "hooks.esign.event.receive",
  summary: "电子签平台回调（V1.1；V1.0 不挂载路由，只在 webhook_event.provider 里声明）",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
});
