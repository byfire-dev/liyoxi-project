// 外部回调与探活 · sms（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookMeta } from "../meta-only.js";

export const hooksSmsStatusReportReceive = hookMeta({
  method: "post",
  path: "/hooks/sms/status-reports",
  operationId: "hooks.sms.statusReport.receive",
  summary: "短信状态回执：校验查询参数 token 后，按服务商流水号只追加写投递行的回执结果",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
});
