// 外部回调与探活 · ci（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookMeta } from "../meta-only.js";

export const hooksCiMediaJobWake = hookMeta({
  method: "post",
  path: "/hooks/ci/media-jobs/{mediaJobId}",
  operationId: "hooks.ci.mediaJob.wake",
  summary:
    "数据万象任务回调：校验查询参数 sig 后唤醒该媒体任务（只把 next_run_at 置为当前），结果以回查任务接口为准",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
});
