// 外部回调与探活 · ci（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookRoute } from "../builders.js";
import { IdSchema } from "../../common/index.js";
import { z } from "../../zod.js";
import { CiWakeQuerySchema, CiWakeBodySchema } from "./ci.schemas.js";

export const hooksCiMediaJobWake = hookRoute({
  method: "post",
  path: "/hooks/ci/media-jobs/{mediaJobId}",
  operationId: "hooks.ci.mediaJob.wake",
  summary:
    "数据万象任务回调：校验查询参数 sig 后唤醒该媒体任务（只把 next_run_at 置为当前），结果以回查任务接口为准",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
  request: {
    params: z.object({ mediaJobId: IdSchema }),
    query: CiWakeQuerySchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: CiWakeBodySchema },
        "application/xml": { schema: CiWakeBodySchema },
      },
    },
  },
  responses: {
    200: { description: "空响应；仅提醒回查" },
    400: { description: "缺少合法JobId" },
    401: { description: "签名非法" },
    413: { description: "传输体积超限" },
    429: { description: "请求过于频繁" },
    500: { description: "配置或持久化失败" },
  },
});
