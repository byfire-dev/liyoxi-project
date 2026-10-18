// 外部回调与探活 · asr（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookRoute } from "../builders.js";
import {
  AsrWakeParamsSchema,
  AsrWakeQuerySchema,
  AsrWakeBodySchema,
  HookAckSchema,
} from "./asr.schemas.js";

export const hooksAsrMediaJobWake = hookRoute({
  method: "post",
  path: "/hooks/asr/media-jobs/{mediaJobId}",
  operationId: "hooks.asr.mediaJob.wake",
  summary: "语音转写任务回调：校验查询参数 sig 后唤醒该媒体任务，结果以回查为准",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
  request: {
    params: AsrWakeParamsSchema,
    query: AsrWakeQuerySchema,
    body: {
      required: true,
      content: { "application/x-www-form-urlencoded": { schema: AsrWakeBodySchema } },
    },
  },
  responses: {
    200: {
      description: "只确认收件/唤醒；结果以回查为准",
      content: { "application/json": { schema: HookAckSchema } },
    },
    400: { description: "缺少唯一合法 requestId" },
    401: { description: "签名非法" },
    404: { description: "ASR来源未配置" },
    413: { description: "传输体积超限" },
    429: { description: "请求过于频繁" },
    500: { description: "持久化失败" },
  },
});
